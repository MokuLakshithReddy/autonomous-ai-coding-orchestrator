import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class AgentToolbox {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath);
  }

  resolveSafePath(targetRelPath: string): string {
    const resolved = path.resolve(this.workspacePath, targetRelPath);
    if (!resolved.startsWith(this.workspacePath)) {
      throw new Error(`Security Exception: Access denied outside workspace boundary (${targetRelPath})`);
    }
    return resolved;
  }

  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolveSafePath(filePath);
    return await fs.readFile(fullPath, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafePath(filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  async replaceInFile(filePath: string, target: string, replacement: string): Promise<boolean> {
    const fullPath = this.resolveSafePath(filePath);
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

  async executeCommand(commandStr: string, timeoutMs = 60000): Promise<CommandResult> {
    this.assertCommandSafety(commandStr);

    const startTime = Date.now();
    return new Promise((resolve) => {
      // Use powershell.exe or cmd.exe on Windows
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'powershell.exe' : '/bin/bash';
      const shellArgs = isWin ? ['-NoProfile', '-Command', commandStr] : ['-c', commandStr];

      const child = spawn(shell, shellArgs, {
        cwd: this.workspacePath,
        env: { ...process.env, CI: 'true' },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: timedOut ? `${stderr}\nCommand timed out after ${timeoutMs}ms` : stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
          durationMs: Date.now() - startTime,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: `Spawn error: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  private assertCommandSafety(command: string): void {
    const normalized = command.toLowerCase().trim();
    const forbiddenPatterns = [
      /\brm\s+-rf\s+[\/\\]/i,
      /\bformat\s+[a-z]:/i,
      /\bdiskpart\b/i,
      /\bgit\s+push\s+.*--force/i,
      /\bdrop\s+database\b/i,
      /\bshutdown\b/i,
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(normalized)) {
        throw new Error(`Security policy blocked potentially destructive command: "${command}"`);
      }
    }
  }
}
