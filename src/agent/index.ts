import { GoogleGenAI } from '@google/genai';
import { AgentToolbox, type CommandResult } from './tools.js';
import { config } from '../config/index.js';
import { RepoInspector } from '../repo/inspector.js';

export interface StepExecutionResult {
  agentName: string;
  success: boolean;
  logs: string;
  toolsUsed: string[];
  diffSummary?: string;
  exitCode: number;
  failureReason?: string;
}

export interface CodingAgent {
  name: string;
  executeStep(
    instruction: string,
    targetFiles?: string[],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult>;
}

export class BuiltInAutonomousAgent implements CodingAgent {
  name = 'BuiltInAutonomousAgent';
  private toolbox: AgentToolbox;
  private workspacePath: string;
  private ai: GoogleGenAI | null = null;
  private modelName: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
    this.modelName = config.geminiModel || 'gemini-2.5-flash';
    if (config.geminiApiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
  }

  async executeStep(
    instruction: string,
    targetFiles: string[] = [],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult> {
    const logs: string[] = [];
    const toolsUsed: string[] = [];
    logs.push(`[Agent: ${this.name}] Beginning execution of step: ${instruction}`);

    if (abortSignal?.aborted) {
      return {
        agentName: this.name,
        success: false,
        logs: '[Agent] Step aborted prior to execution.',
        toolsUsed: [],
        exitCode: 130,
        failureReason: 'Execution cancelled by abort signal',
      };
    }

    // If Gemini is configured, use autonomous tool-assisted execution
    if (this.ai) {
      return await this.executeWithGemini(instruction, targetFiles, logs, toolsUsed, abortSignal);
    }

    // Fallback if no API key is supplied: P0.1 FIX - Never report success when no work was performed!
    logs.push(`[Agent: ${this.name}] Running in local fallback execution mode.`);
    const failureReason = 'Execution failed: No GEMINI_API_KEY configured. Autonomous implementation requires an active LLM engine. No code changes were performed.';
    logs.push(`[Agent: Error] ${failureReason}`);
    return {
      agentName: this.name,
      success: false,
      logs: logs.join('\n'),
      toolsUsed: [],
      exitCode: 1,
      failureReason,
    };
  }

  private async executeWithGemini(
    instruction: string,
    targetFiles: string[],
    logs: string[],
    toolsUsed: string[],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult> {
    const maxIterations = 5;
    let iteration = 0;
    let currentTask = instruction;
    let completedCleanly = false;
    let encounteredError = false;
    let failureReason: string | undefined;

    while (iteration < maxIterations) {
      if (abortSignal?.aborted) {
        logs.push('[Agent] Execution cancelled by abort signal.');
        encounteredError = true;
        failureReason = 'Step cancelled by abort signal';
        break;
      }

      iteration++;
      logs.push(`\n--- Iteration ${iteration}/${maxIterations} ---`);

      // Gather current file contexts if targetFiles are specified
      const fileContexts: Record<string, string> = {};
      for (const tf of targetFiles) {
        try {
          fileContexts[tf] = await this.toolbox.readFile(tf);
        } catch {
          fileContexts[tf] = '(File does not exist yet)';
        }
      }

      const prompt = `
You are an Autonomous Software Engineer executing a specific coding task.
Task: ${currentTask}
Target Files: ${targetFiles.join(', ') || 'Any relevant files'}

File Contexts:
${Object.entries(fileContexts)
  .map(([f, content]) => `=== ${f} ===\n${content.slice(0, 3000)}`)
  .join('\n\n')}

Decide on the next action to take. You can choose ONE action:
1. "writeFile": Create or overwrite a file with complete content.
2. "executeCommand": Run a terminal command (e.g. build, test, install, format).
3. "complete": Finish the step and declare work complete.

Output your response ONLY in valid JSON matching this schema:
{
  "thought": "Your reasoning about what needs to be done next",
  "action": "writeFile" | "executeCommand" | "complete",
  "filePath": "src/example.ts (if action is writeFile)",
  "fileContent": "the code to write (if action is writeFile)",
  "command": "npm.cmd test (if action is executeCommand)",
  "summary": "Summary of action"
}
`;

      try {
        const response = await this.ai!.models.generateContent({
          model: this.modelName,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        let actionJson: any;
        try {
          actionJson = JSON.parse(response.text || '{}');
        } catch (parseErr: any) {
          encounteredError = true;
          failureReason = `Agent emitted malformed JSON response: ${parseErr.message}`;
          logs.push(`[Error] ${failureReason}`);
          break;
        }

        logs.push(`[Thought]: ${actionJson.thought || 'Executing next step'}`);

        if (actionJson.action === 'complete') {
          logs.push(`[Agent] Step declared complete: ${actionJson.summary || 'All actions performed'}`);
          completedCleanly = true;
          break;
        } else if (actionJson.action === 'writeFile') {
          if (!actionJson.filePath || actionJson.fileContent === undefined) {
            encounteredError = true;
            failureReason = 'writeFile action missing filePath or fileContent';
            logs.push(`[Error] ${failureReason}`);
            break;
          }
          logs.push(`[Action] Writing file: ${actionJson.filePath}`);
          await this.toolbox.writeFile(actionJson.filePath, actionJson.fileContent);
          toolsUsed.push(`writeFile:${actionJson.filePath}`);
        } else if (actionJson.action === 'executeCommand') {
          if (!actionJson.command) {
            encounteredError = true;
            failureReason = 'executeCommand action missing command string';
            logs.push(`[Error] ${failureReason}`);
            break;
          }
          logs.push(`[Action] Running command: ${actionJson.command}`);
          const res = await this.toolbox.executeCommand(actionJson.command, 60000, {}, abortSignal);
          toolsUsed.push(`executeCommand:${actionJson.command}`);
          logs.push(`[Command Output]:\n${res.stdout}`);
          if (res.stderr) logs.push(`[Command Stderr]:\n${res.stderr}`);

          if (res.exitCode !== 0) {
            logs.push(`[Warning] Command exited with non-zero code ${res.exitCode}`);
            // Non-zero command exit does not necessarily abort the loop if the agent can self-correct in next iteration,
            // but if iteration finishes without complete, it fails.
          }
        } else {
          encounteredError = true;
          failureReason = `Invalid action requested: "${actionJson.action}"`;
          logs.push(`[Agent] ${failureReason}`);
          break;
        }
      } catch (err: any) {
        encounteredError = true;
        failureReason = `Exception in agent execution loop: ${err?.message}`;
        logs.push(`[Error in Agent Loop]: ${err?.message}`);
        break;
      }
    }

    // P0.1 FIX: If loop terminated without clean complete action or with an unhandled error, mark success = false!
    if (!completedCleanly && !failureReason) {
      failureReason = `Agent exhausted max iterations (${maxIterations}) without declaring completion.`;
      encounteredError = true;
      logs.push(`[Agent Error] ${failureReason}`);
    }

    const inspector = new RepoInspector(this.workspacePath);
    const diff = await inspector.getDiff();
    const success = completedCleanly && !encounteredError;

    return {
      agentName: this.name,
      success,
      logs: logs.join('\n'),
      toolsUsed,
      diffSummary: diff.slice(0, 2000),
      exitCode: success ? 0 : 1,
      failureReason,
    };
  }
}

// Adapter for external CLI coding agents like Aider
export class AiderAgentAdapter implements CodingAgent {
  name = 'AiderAgentAdapter';
  private toolbox: AgentToolbox;

  constructor(workspacePath: string) {
    this.toolbox = new AgentToolbox(workspacePath);
  }

  async executeStep(
    instruction: string,
    targetFiles: string[] = [],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult> {
    const filesArg = targetFiles.join(' ');
    const cmd = `aider --yes --message "${instruction.replace(/"/g, '\\"')}" ${filesArg}`;
    const result = await this.toolbox.executeCommand(cmd, 180000, {}, abortSignal);

    return {
      agentName: this.name,
      success: result.exitCode === 0,
      logs: `${result.stdout}\n${result.stderr}`,
      toolsUsed: ['aider-cli'],
      exitCode: result.exitCode,
      failureReason: result.exitCode === 0 ? undefined : `Aider CLI exited with code ${result.exitCode}`,
    };
  }
}
