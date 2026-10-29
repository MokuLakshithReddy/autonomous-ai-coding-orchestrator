import { GoogleGenAI } from '@google/genai';
import { AgentToolbox, type CommandResult, type ApprovalCallback } from './tools.js';
import { config } from '../config/index.js';
import { RepoInspector } from '../repo/inspector.js';
import { type TokenUsageMetadata, calculateGeminiCost } from '../llm/index.js';

export interface StepExecutionResult {
  agentName: string;
  success: boolean;
  logs: string;
  toolsUsed: string[];
  diffSummary?: string;
  exitCode: number;
  failureReason?: string;
  agentResolution?: 'declared_completion' | 'exhausted_iterations' | 'execution_error';
}

export interface CodingAgent {
  name: string;
  workspacePath?: string;
  executeStep(
    instruction: string,
    targetFiles?: string[],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult>;
  setWorkspacePath?(workspacePath: string): void;
}

export interface GenAIClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config?: { responseMimeType?: string };
    }): Promise<{ text?: string | null; usageMetadata?: any }>;
  };
}

export class BuiltInAutonomousAgent implements CodingAgent {
  name = 'BuiltInAutonomousAgent';
  private toolbox: AgentToolbox;
  public workspacePath: string;
  private ai: GenAIClient | GoogleGenAI | null = null;
  private modelName: string;
  private onRequestApproval?: ApprovalCallback;
  private tokenUsage: TokenUsageMetadata = { promptTokens: 0, candidatesTokens: 0, totalTokens: 0, measuredCost: 0 };

  constructor(
    workspacePath: string,
    onRequestApproval?: ApprovalCallback,
    modelClient?: GenAIClient
  ) {
    this.workspacePath = workspacePath;
    this.onRequestApproval = onRequestApproval;
    this.toolbox = new AgentToolbox(workspacePath, onRequestApproval);
    this.modelName = config.geminiModel || 'gemini-flash-lite-latest';
    if (modelClient) {
      this.ai = modelClient;
    } else if (config.geminiApiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
  }

  getTokenUsage(): TokenUsageMetadata {
    return { ...this.tokenUsage };
  }

  private recordUsage(usageMetadata?: any): void {
    if (!usageMetadata) return;
    const p = usageMetadata.promptTokenCount || 0;
    const c = usageMetadata.candidatesTokenCount || 0;
    this.tokenUsage.promptTokens += p;
    this.tokenUsage.candidatesTokens += c;
    this.tokenUsage.totalTokens += usageMetadata.totalTokenCount || (p + c);
    this.tokenUsage.measuredCost = calculateGeminiCost(this.tokenUsage.promptTokens, this.tokenUsage.candidatesTokens);
  }

  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath, this.onRequestApproval);
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
    const maxIterations = 15;
    let iteration = 0;
    let currentTask = instruction;
    let completedCleanly = false;
    let encounteredError = false;
    let failureReason: string | undefined;
    const recentActions: Array<{ iter: number; action: string; summary?: string; commandOutput?: string }> = [];

    while (iteration < maxIterations) {
      if (abortSignal?.aborted) {
        logs.push('[Agent] Execution cancelled by abort signal.');
        encounteredError = true;
        failureReason = 'Step cancelled by abort signal';
        break;
      }

      iteration++;
      logs.push(`\n--- Iteration ${iteration}/${maxIterations} ---`);

      // Gather current file contexts (auto-populate target files and related workspace files)
      const fileContexts: Record<string, string> = {};
      const targetSet = new Set(targetFiles.filter(Boolean));
      if (targetSet.size === 0) {
        try {
          const allFiles = await this.toolbox.listFiles();
          for (const f of allFiles.filter((f) => !f.endsWith('/') && !f.includes('node_modules')).slice(0, 8)) {
            targetSet.add(f);
          }
        } catch { }
      } else {
        // Also include related workspace source files (up to 8 files) for cross-file contract awareness
        try {
          const allFiles = await this.toolbox.listFiles();
          for (const f of allFiles.filter((f) => !f.endsWith('/') && !f.includes('node_modules'))) {
            if (targetSet.size >= 8) break;
            targetSet.add(f);
          }
        } catch { }
      }

      for (const tf of targetSet) {
        try {
          fileContexts[tf] = await this.toolbox.readFile(tf);
        } catch {
          fileContexts[tf] = '(File does not exist yet)';
        }
      }

      const prompt = `
You are an Autonomous Software Engineer executing a specific coding task.
Task: ${currentTask}
Target Files: ${targetFiles.join(', ') || 'Any relevant files in repository'}

File Contexts:
${Object.entries(fileContexts)
          .map(([f, content]) => `=== ${f} ===\n${content.slice(0, 6000)}`)
          .join('\n\n')}
${recentActions.length > 0 ? `
Recent Actions & Execution Results:
${recentActions.slice(-4).map(a => `- Iteration ${a.iter} [${a.action}]: ${a.summary || ''}${a.commandOutput ? '\n  Output:\n' + a.commandOutput.slice(-500) : ''}`).join('\n')}
` : ''}

Decide on the next action to take. You can choose ONE action:
1. "writeFile": Create or overwrite a file with complete content.
2. "readFile": Read the contents of a file in the workspace.
3. "replaceInFile": Surgically replace exact code substring in a file with replacement string (avoids rewriting entire file).
4. "searchCode": Search for text or regex pattern across repository files.
5. "listFiles": List files in a workspace directory.
6. "executeCommand": Run a terminal command (e.g. test, build, install, lint).
7. "complete": Finish the step and declare work complete.

Rules:
- If a test command was executed and passed with exit code 0 (all tests passed), the repair is successful! Return action: "complete" immediately. Do NOT run the test repeatedly in a loop.
- Use "replaceInFile" for surgical bug fixes to preserve the rest of the file without truncation risks.
- When writing files with "writeFile", always provide the complete file content.

Output your response ONLY in valid JSON matching this schema:
{
  "thought": "Your reasoning about what needs to be done next",
  "action": "writeFile" | "readFile" | "replaceInFile" | "searchCode" | "listFiles" | "executeCommand" | "complete",
  "filePath": "path/to/file (for writeFile, readFile, replaceInFile)",
  "fileContent": "the code to write (for writeFile)",
  "target": "exact string to replace (for replaceInFile)",
  "replacement": "replacement string (for replaceInFile)",
  "searchQuery": "text or regex to search (for searchCode)",
  "dirPath": "relative directory path (for listFiles, default '.')",
  "command": "terminal command (for executeCommand)",
  "summary": "Summary of action"
}
`;

      try {
        let response: any;
        let modelAttempts = 0;
        while (modelAttempts < 3) {
          try {
            response = await this.ai!.models.generateContent({
              model: this.modelName,
              contents: prompt,
              config: {
                responseMimeType: 'application/json',
              },
            });
            this.recordUsage(response?.usageMetadata);
            break;
          } catch (modelErr: any) {
            modelAttempts++;
            const errMsg = modelErr?.message || '';
            const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('limit: 5');
            const isUnavailable = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand');
            if ((isRateLimit || isUnavailable) && modelAttempts < 3) {
              let waitMs = 15000;
              const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
              if (match) {
                const parsedSec = parseFloat(match[1]);
                waitMs = (parsedSec > 1000 ? Math.ceil(parsedSec) : Math.ceil(parsedSec * 1000)) + 1000;
              }
              waitMs = Math.min(Math.max(waitMs, 5000), 30000);
              logs.push(`[Gemini Backoff] Received ${isRateLimit ? '429 Rate Limit' : '503 High Demand'}. Pausing ${Math.round(waitMs / 1000)}s for Free Tier quota window...`);
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
            throw modelErr;
          }
        }

        let rawText = (response.text || '{}').trim();
        rawText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        let actionJson: any;
        try {
          actionJson = JSON.parse(rawText);
        } catch (parseErr: any) {
          // Attempt sanitization: escape unescaped control characters inside JSON string literals
          try {
            let inString = false;
            let escaped = false;
            let sanitized = '';
            for (let idx = 0; idx < rawText.length; idx++) {
              const char = rawText[idx];
              if (char === '"' && !escaped) {
                inString = !inString;
                sanitized += char;
              } else if (inString && !escaped) {
                if (char === '\n') sanitized += '\\n';
                else if (char === '\r') sanitized += '\\r';
                else if (char === '\t') sanitized += '\\t';
                else sanitized += char;
              } else {
                sanitized += char;
              }
              escaped = char === '\\' && !escaped;
            }
            actionJson = JSON.parse(sanitized);
          } catch {
            logs.push(`[Iteration ${iteration} Warning] Malformed JSON emitted by model: ${parseErr.message}`);
            recentActions.push({
              iter: iteration,
              action: 'error',
              summary: `Failed to parse response JSON: ${parseErr.message}. Output strictly valid JSON.`,
            });
            continue;
          }
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
          recentActions.push({
            iter: iteration,
            action: 'writeFile',
            summary: `Wrote file ${actionJson.filePath}`,
          });
        } else if (actionJson.action === 'readFile') {
          if (!actionJson.filePath) {
            encounteredError = true;
            failureReason = 'readFile action missing filePath';
            logs.push(`[Error] ${failureReason}`);
            break;
          }
          logs.push(`[Action] Reading file: ${actionJson.filePath}`);
          try {
            const content = await this.toolbox.readFile(actionJson.filePath);
            logs.push(`[Read Content from ${actionJson.filePath}]:\n${content.slice(0, 2000)}`);
            toolsUsed.push(`readFile:${actionJson.filePath}`);
            recentActions.push({
              iter: iteration,
              action: 'readFile',
              summary: `Inspected ${actionJson.filePath}`,
            });
          } catch (readErr: any) {
            logs.push(`[Warning] Could not read ${actionJson.filePath}: ${readErr.message}`);
          }
        } else if (actionJson.action === 'replaceInFile') {
          if (!actionJson.filePath || actionJson.target === undefined || actionJson.replacement === undefined) {
            encounteredError = true;
            failureReason = 'replaceInFile action requires filePath, target, and replacement strings';
            logs.push(`[Error] ${failureReason}`);
            break;
          }
          logs.push(`[Action] Surgically replacing substring in: ${actionJson.filePath}`);
          const replaced = await this.toolbox.replaceInFile(actionJson.filePath, actionJson.target, actionJson.replacement);
          if (replaced) {
            toolsUsed.push(`replaceInFile:${actionJson.filePath}`);
            recentActions.push({
              iter: iteration,
              action: 'replaceInFile',
              summary: `Replaced code in ${actionJson.filePath}`,
            });
          } else {
            logs.push(`[Warning] Target substring was not found in ${actionJson.filePath}`);
            recentActions.push({
              iter: iteration,
              action: 'replaceInFile',
              summary: `Target substring not found in ${actionJson.filePath}`,
            });
          }
        } else if (actionJson.action === 'searchCode') {
          const query = actionJson.searchQuery || actionJson.command || '';
          logs.push(`[Action] Searching codebase for pattern: "${query}"`);
          const matches = await this.toolbox.searchCode(query);
          const matchSummaries = matches.slice(0, 10).map((m) => `${m.file}:${m.line}: ${m.content}`).join('\n');
          logs.push(`[Search Results (${matches.length} found)]:\n${matchSummaries || 'No matches found.'}`);
          toolsUsed.push(`searchCode:${query}`);
          recentActions.push({
            iter: iteration,
            action: 'searchCode',
            summary: `Found ${matches.length} matches for "${query}"`,
          });
        } else if (actionJson.action === 'listFiles') {
          const dir = actionJson.dirPath || '.';
          logs.push(`[Action] Listing workspace files in: "${dir}"`);
          const files = await this.toolbox.listFiles(dir);
          logs.push(`[Files in ${dir}]:\n${files.slice(0, 30).join('\n')}`);
          toolsUsed.push(`listFiles:${dir}`);
          recentActions.push({
            iter: iteration,
            action: 'listFiles',
            summary: `Listed ${files.length} files in ${dir}`,
          });
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

          recentActions.push({
            iter: iteration,
            action: 'executeCommand',
            summary: `Ran ${actionJson.command} (exit ${res.exitCode})`,
            commandOutput: `${res.stdout}${res.stderr ? '\n' + res.stderr : ''}`.trim(),
          });

          if (res.exitCode !== 0) {
            logs.push(`[Warning] Command exited with non-zero code ${res.exitCode}`);
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

    // Determine specific agent resolution outcome
    let agentResolution: 'declared_completion' | 'exhausted_iterations' | 'execution_error' = 'declared_completion';
    if (completedCleanly && !encounteredError) {
      agentResolution = 'declared_completion';
    } else if (!failureReason || failureReason.includes('exhausted max iterations')) {
      agentResolution = 'exhausted_iterations';
    } else {
      agentResolution = 'execution_error';
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
      agentResolution,
    };
  }
}

// Adapter for external CLI coding agents like Aider
export class AiderAgentAdapter implements CodingAgent {
  name = 'AiderAgentAdapter';
  public workspacePath: string;
  private toolbox: AgentToolbox;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
  }

  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
  }

  async executeStep(
    instruction: string,
    targetFiles: string[] = [],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult> {
    const filesArg = targetFiles.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    const escapedInstruction = instruction.replace(/"/g, '\\"');
    const cmd = `aider --yes --message "${escapedInstruction}" ${filesArg}`.trim();
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

// Adapter for Claude Code CLI agent
export class ClaudeCodeAgentAdapter implements CodingAgent {
  name = 'ClaudeCodeAgentAdapter';
  public workspacePath: string;
  private toolbox: AgentToolbox;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
  }

  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
  }

  async executeStep(
    instruction: string,
    targetFiles: string[] = [],
    abortSignal?: AbortSignal
  ): Promise<StepExecutionResult> {
    const filesHint = targetFiles.length > 0 ? ` Target files: ${targetFiles.join(', ')}.` : '';
    const fullPrompt = `${instruction}${filesHint}`.replace(/"/g, '\\"');
    const cmd = `claude -p "${fullPrompt}"`;
    const result = await this.toolbox.executeCommand(cmd, 240000, {}, abortSignal);

    return {
      agentName: this.name,
      success: result.exitCode === 0,
      logs: `${result.stdout}\n${result.stderr}`,
      toolsUsed: ['claude-code-cli'],
      exitCode: result.exitCode,
      failureReason: result.exitCode === 0 ? undefined : `Claude Code CLI exited with code ${result.exitCode}`,
    };
  }
}

export function createAgent(
  type: string = 'builtin',
  workspacePath: string,
  onRequestApproval?: ApprovalCallback,
  modelClient?: GenAIClient
): CodingAgent {
  switch (type.toLowerCase()) {
    case 'aider':
      return new AiderAgentAdapter(workspacePath);
    case 'claude':
    case 'claudecode':
      return new ClaudeCodeAgentAdapter(workspacePath);
    case 'builtin':
    default:
      return new BuiltInAutonomousAgent(workspacePath, onRequestApproval, modelClient);
  }
}
