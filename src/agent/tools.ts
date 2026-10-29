import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import { SecurityPolicyEngine, type ActionPolicy } from '../security/policy.js';
import { ContainerSandbox } from '../security/sandbox.js';
import { config } from '../config/index.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type ApprovalCallback = (commandOrAction: string, risk: ActionPolicy) => Promise<boolean>;

export class AgentToolbox {
  private workspacePath: string;
  private onRequestApproval?: ApprovalCallback;
  private maxOutputBytes = 500 * 1024; // 500 KB output limit per command

  constructor(workspacePath: string, onRequestApproval?: ApprovalCallback) {
    this.workspacePath = SecurityPolicyEngine.resolveCanonicalPath(workspacePath);
    this.onRequestApproval = onRequestApproval;
  }

  resolveSafePath(targetRelPath: string): string {
    return SecurityPolicyEngine.assertPathContainment(targetRelPath, this.workspacePath);
  }

  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolveSafePath(filePath);
    if (SecurityPolicyEngine.isSensitiveSecret(filePath)) {
      throw new Error(
        `Security Exception [Access Denied]: Reading sensitive secret file "${filePath}" is strictly prohibited.`
      );
    }
    const content = await fs.readFile(fullPath, 'utf8');
    const secretScan = SecurityPolicyEngine.containsSensitiveSecret(content);
    if (secretScan.hasSecret) {
      throw new Error(
        `Security Exception [Secret Blocked]: File "${filePath}" contains detected credentials or secret material (${secretScan.reason}) and cannot be read.`
      );
    }
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafePath(filePath);
    const policy = SecurityPolicyEngine.evaluateFileWriteRisk(filePath);
    if (policy.requiresApproval) {
      if (!this.onRequestApproval) {
        throw new Error(`Security Exception [Approval Required]: Writing to sensitive destination "${filePath}" requires operator approval.`);
      }
      const isApproved = await this.onRequestApproval(`write ${filePath}`, policy);
      if (!isApproved) {
        throw new Error(`Security Exception [Approval Denied]: Writing to sensitive destination "${filePath}" was rejected by the operator.`);
      }
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  async replaceInFile(filePath: string, target: string, replacement: string): Promise<boolean> {
    const fullPath = this.resolveSafePath(filePath);
    const policy = SecurityPolicyEngine.evaluateFileWriteRisk(filePath);
    if (policy.requiresApproval) {
      if (!this.onRequestApproval) {
        throw new Error(`Security Exception [Approval Required]: Modifying sensitive destination "${filePath}" requires operator approval.`);
      }
      const isApproved = await this.onRequestApproval(`modify ${filePath}`, policy);
      if (!isApproved) {
        throw new Error(`Security Exception [Approval Denied]: Modification of sensitive destination "${filePath}" was rejected by the operator.`);
      }
    }
    const content = await fs.readFile(fullPath, 'utf8');
    if (!content.includes(target)) {
      return false;
    }
    const updated = content.replace(target, replacement);
    await fs.writeFile(fullPath, updated, 'utf8');
    return true;
  }

  async deleteFile(filePath: string): Promise<boolean> {
    const fullPath = this.resolveSafePath(filePath);
    const policy = SecurityPolicyEngine.evaluateActionRisk('delete file', filePath);
    if (policy.requiresApproval) {
      if (!this.onRequestApproval) {
        throw new Error(`Security Exception [Approval Required]: Deletion of "${filePath}" requires operator approval.`);
      }
      const isApproved = await this.onRequestApproval(`delete ${filePath}`, policy);
      if (!isApproved) {
        throw new Error(`Security Exception [Approval Denied]: Deletion of "${filePath}" was rejected by the operator.`);
      }
    }
    try {
      await fs.unlink(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(dirRelPath = '.'): Promise<string[]> {
    const targetDir = this.resolveSafePath(dirRelPath);
    const results: string[] = [];

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', '.venv', '__pycache__'].includes(entry.name)) {
          continue;
        }
        if (SecurityPolicyEngine.isSensitiveSecret(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.workspacePath, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          await walk(full);
        } else {
          results.push(rel);
        }
      }
    };

    await walk(targetDir);
    return results;
  }

  async searchCode(regexQuery: string): Promise<Array<{ file: string; line: number; content: string }>> {
    const files = await this.listFiles();
    const regex = new RegExp(regexQuery, 'i');
    const matches: Array<{ file: string; line: number; content: string }> = [];

    for (const relFile of files) {
      if (relFile.endsWith('/')) continue;
      try {
        const content = await this.readFile(relFile);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: relFile, line: i + 1, content: lines[i].trim() });
            if (matches.length >= 100) return matches;
          }
        }
      } catch {}
    }

    return matches;
  }

  /**
   * P0 FIX: Unified command executor.
   * All commands (shell scripts, build runners, test suites, and external agent executables)
   * route through this single runner. When container isolation is active, execution is
   * unconditionally delegated to ContainerSandbox with argument boundaries preserved.
   */
  private async executeUnified(
    target: { type: 'shell'; commandStr: string } | { type: 'exec'; executable: string; args: string[] },
    commandStrForAudit: string,
    timeoutMs = 60000,
    customEnv: Record<string, string> = {},
    abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    // P0 FIX: High and critical operations must flow through consistent approve-or-reject action gate
    const policy = SecurityPolicyEngine.evaluateCommandRisk(commandStrForAudit);
    if (policy.requiresApproval) {
      if (!this.onRequestApproval) {
        throw new Error(
          `Security Exception [Approval Required]: Command "${commandStrForAudit}" requires approval (${policy.riskLevel}: ${policy.reason}), but no approval handler is configured.`
        );
      }
      const isApproved = await this.onRequestApproval(commandStrForAudit, policy);
      if (!isApproved) {
        throw new Error(
          `Security Exception [Approval Denied]: Execution of command "${commandStrForAudit}" was rejected by the operator.`
        );
      }
    }

    if (abortSignal?.aborted) {
      return {
        stdout: '',
        stderr: 'Command execution aborted prior to spawn.',
        exitCode: 130,
        durationMs: 0,
        cancelled: true,
      };
    }

    const startTime = Date.now();
    const sanitizedEnv = SecurityPolicyEngine.getSanitizedProcessEnv(customEnv);
    const isContainerMode = process.env.USE_CONTAINER_SANDBOX === 'true' || config.useContainerSandbox;

    let spawnExec: string;
    let spawnArgs: string[];

    const isExternalAgent =
      target.type === 'exec' &&
      ['aider', 'claude'].includes(
        path.basename(target.executable).toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/, '')
      );

    if (isContainerMode) {
      // P0 FIX: Mandatory fail closed if container isolation is enabled but Docker is unavailable
      await ContainerSandbox.assertSandboxAvailable();

      const wrapped = ContainerSandbox.buildDockerRunArgs(this.workspacePath, target, {
        env: sanitizedEnv,
        forwardApiKeys: isExternalAgent,
      });
      spawnExec = wrapped.executable;
      spawnArgs = wrapped.args;
    } else {
      if (target.type === 'shell') {
        const isWin = process.platform === 'win32';
        spawnExec = isWin ? 'powershell.exe' : '/bin/bash';
        spawnArgs = isWin
          ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', target.commandStr]
          : ['-c', target.commandStr];
      } else {
        spawnExec = target.executable;
        spawnArgs = target.args;

        // P0/P1 FIX: Robust Windows script launcher & execution
        if (process.platform === 'win32') {
          const lower = spawnExec.toLowerCase();
          if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower === 'aider' || lower === 'claude') {
            spawnExec = process.env.COMSPEC || 'cmd.exe';
            spawnArgs = ['/d', '/s', '/c', target.executable, ...target.args];
          }
        }
      }
    }

    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;

      const terminateChild = (reason: 'timeout' | 'cancel') => {
        if (child?.pid) {
          try {
            treeKill(child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateChild('timeout');
      }, timeoutMs);

      const abortHandler = () => {
        cancelled = true;
        terminateChild('cancel');
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        child = spawn(spawnExec, spawnArgs, {
          cwd: this.workspacePath,
          env: sanitizedEnv,
          shell: false,
          windowsHide: true,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        return resolve({
          stdout: '',
          stderr: `Spawn invocation failed: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
          timedOut: false,
          cancelled: false,
        });
      }

      child.stdout?.on('data', (data) => {
        const chunk = data.toString();
        if (stdout.length < this.maxOutputBytes) {
          stdout += chunk;
        } else if (!stdout.endsWith('\n... [Output truncated: buffer exceeded 500KB]')) {
          stdout += '\n... [Output truncated: buffer exceeded 500KB]';
        }
      });

      child.stderr?.on('data', (data) => {
        const chunk = data.toString();
        if (stderr.length < this.maxOutputBytes) {
          stderr += chunk;
        } else if (!stderr.endsWith('\n... [Output truncated: buffer exceeded 500KB]')) {
          stderr += '\n... [Output truncated: buffer exceeded 500KB]';
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }

        let finalStderr = stderr;
        if (timedOut) {
          finalStderr = `${stderr}\nExecution timeout reached after ${timeoutMs}ms.`;
        } else if (cancelled) {
          finalStderr = `${stderr}\nExecution cancelled by abort signal.`;
        }

        resolve({
          stdout: SecurityPolicyEngine.redactSensitiveData(stdout),
          stderr: SecurityPolicyEngine.redactSensitiveData(finalStderr),
          exitCode: timedOut ? 124 : cancelled ? 130 : (code ?? 1),
          durationMs: Date.now() - startTime,
          timedOut,
          cancelled,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve({
          stdout: SecurityPolicyEngine.redactSensitiveData(stdout),
          stderr: SecurityPolicyEngine.redactSensitiveData(`Subprocess spawn error: ${err.message}`),
          exitCode: 1,
          durationMs: Date.now() - startTime,
          timedOut: false,
          cancelled,
        });
      });
    });
  }

  async executeCommand(
    commandStr: string,
    timeoutMs = 60000,
    customEnv: Record<string, string> = {},
    abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    return this.executeUnified({ type: 'shell', commandStr }, commandStr, timeoutMs, customEnv, abortSignal);
  }

  async executeCommandWithArgs(
    executable: string,
    args: string[],
    timeoutMs = 60000,
    customEnv: Record<string, string> = {},
    abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    const fullCommandStr = `${executable} ${args.join(' ')}`.trim();
    return this.executeUnified({ type: 'exec', executable, args }, fullCommandStr, timeoutMs, customEnv, abortSignal);
  }
}
