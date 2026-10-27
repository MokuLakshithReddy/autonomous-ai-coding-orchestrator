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
}

export interface CodingAgent {
  name: string;
  executeStep(instruction: string, targetFiles?: string[]): Promise<StepExecutionResult>;
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

  async executeStep(instruction: string, targetFiles: string[] = []): Promise<StepExecutionResult> {
    const logs: string[] = [];
    const toolsUsed: string[] = [];
    logs.push(`[Agent: ${this.name}] Beginning execution of step: ${instruction}`);

    // If Gemini is configured, use autonomous tool-assisted execution
    if (this.ai) {
      return await this.executeWithGemini(instruction, targetFiles, logs, toolsUsed);
    }

    // Fallback if no API key is supplied yet: run basic project build/test check or file scaffolding
    logs.push(`[Agent: ${this.name}] Running in local fallback execution mode.`);
    const inspector = new RepoInspector(this.workspacePath);
    const meta = await inspector.inspect();

    if (meta.buildCmd) {
      logs.push(`[Agent] Executing detected build command: ${meta.buildCmd}`);
      toolsUsed.push('executeCommand');
      const res = await this.toolbox.executeCommand(meta.buildCmd);
      logs.push(res.stdout);
      if (res.stderr) logs.push(res.stderr);
      return {
        agentName: this.name,
        success: res.exitCode === 0,
        logs: logs.join('\n'),
        toolsUsed,
        exitCode: res.exitCode,
      };
    }

    logs.push(`[Agent] Step processed. Please configure GEMINI_API_KEY for dynamic autonomous code editing.`);
    return {
      agentName: this.name,
      success: true,
      logs: logs.join('\n'),
      toolsUsed,
      exitCode: 0,
    };
  }

  private async executeWithGemini(
    instruction: string,
    targetFiles: string[],
    logs: string[],
    toolsUsed: string[]
  ): Promise<StepExecutionResult> {
    const maxIterations = 5;
    let iteration = 0;
    let currentTask = instruction;

    while (iteration < maxIterations) {
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

        const actionJson = JSON.parse(response.text || '{}');
        logs.push(`[Thought]: ${actionJson.thought || 'Executing next step'}`);

        if (actionJson.action === 'complete') {
          logs.push(`[Agent] Step marked complete: ${actionJson.summary || 'All actions performed'}`);
          break;
        } else if (actionJson.action === 'writeFile' && actionJson.filePath && actionJson.fileContent !== undefined) {
          logs.push(`[Action] Writing file: ${actionJson.filePath}`);
          await this.toolbox.writeFile(actionJson.filePath, actionJson.fileContent);
          toolsUsed.push(`writeFile:${actionJson.filePath}`);
        } else if (actionJson.action === 'executeCommand' && actionJson.command) {
          logs.push(`[Action] Running command: ${actionJson.command}`);
          const res = await this.toolbox.executeCommand(actionJson.command);
          toolsUsed.push(`executeCommand:${actionJson.command}`);
          logs.push(`[Command Output]:\n${res.stdout}`);
          if (res.stderr) logs.push(`[Command Stderr]:\n${res.stderr}`);
          if (res.exitCode !== 0) {
            logs.push(`[Warning] Command exited with non-zero code ${res.exitCode}`);
          }
        } else {
          logs.push(`[Agent] No further action specified. Completing iteration.`);
          break;
        }
      } catch (err: any) {
        logs.push(`[Error in Agent Loop]: ${err?.message}`);
        break;
      }
    }

    const inspector = new RepoInspector(this.workspacePath);
    const diff = await inspector.getDiff();

    return {
      agentName: this.name,
      success: true,
      logs: logs.join('\n'),
      toolsUsed,
      diffSummary: diff.slice(0, 2000),
      exitCode: 0,
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

  async executeStep(instruction: string, targetFiles: string[] = []): Promise<StepExecutionResult> {
    const filesArg = targetFiles.join(' ');
    const cmd = `aider --yes --message "${instruction.replace(/"/g, '\\"')}" ${filesArg}`;
    const result = await this.toolbox.executeCommand(cmd, 180000);

    return {
      agentName: this.name,
      success: result.exitCode === 0,
      logs: `${result.stdout}\n${result.stderr}`,
      toolsUsed: ['aider-cli'],
      exitCode: result.exitCode,
    };
  }
}
