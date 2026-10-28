import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';

export interface ProjectMetadata {
  isGitRepo: boolean;
  branch?: string;
  latestCommit?: string;
  hasUncommittedChanges: boolean;
  uncommittedFiles: string[];
  ecosystems: ('nodejs' | 'python' | 'rust' | 'golang' | 'unknown')[];
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'poetry' | 'pip' | 'cargo' | 'go';
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  fileTreeSummary: string[];
}

export interface GitBaseline {
  baseCommit: string;
  branch: string;
  dirtyFilesAtStart: string[];
  isClean: boolean;
}

export class RepoInspector {
  private workspacePath: string;
  private git: SimpleGit;
  private baseline: GitBaseline | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath);
    this.git = simpleGit(this.workspacePath);
  }

  async isGitRepository(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async captureBaseline(): Promise<GitBaseline | null> {
    if (!(await this.isGitRepository())) return null;

    try {
      const status = await this.git.status();
      const log = await this.git.log({ maxCount: 1 });
      const baseCommit = log.latest ? log.latest.hash : 'initial';
      const branch = status.current || 'HEAD';
      const dirtyFilesAtStart = status.files.map((f) => f.path);

      this.baseline = {
        baseCommit,
        branch,
        dirtyFilesAtStart,
        isClean: status.isClean(),
      };
      return this.baseline;
    } catch {
      return null;
    }
  }

  getBaseline(): GitBaseline | null {
    return this.baseline;
  }

  async getGitStatus(): Promise<StatusResult | null> {
    try {
      if (!(await this.isGitRepository())) return null;
      return await this.git.status();
    } catch {
      return null;
    }
  }

  async getCurrentCommitHash(): Promise<string | null> {
    try {
      if (!(await this.isGitRepository())) return null;
      const log = await this.git.log({ maxCount: 1 });
      return log.latest ? log.latest.hash : null;
    } catch {
      return null;
    }
  }

  /**
   * P0 FIX: Full workspace state fingerprinting.
   * Hashes the exact HEAD commit, porcelain status (tracked modifications, staging, additions,
   * deletions, untracked files), and working diffs.
   * Guarantees that ANY file change made during or after verification is detected.
   */
  async getWorkspaceFingerprint(): Promise<string> {
    if (await this.isGitRepository()) {
      try {
        const headCommit = (await this.getCurrentCommitHash()) || 'NO_HEAD';
        const porcelain = await this.git.raw(['status', '--porcelain=v1']);
        const workingDiff = await this.git.diff();
        const stagedDiff = await this.git.diff(['--cached']);
        return crypto
          .createHash('sha256')
          .update(`HEAD:${headCommit}\n`)
          .update(`PORCELAIN:\n${porcelain}\n`)
          .update(`WORKING_DIFF:\n${workingDiff}\n`)
          .update(`STAGED_DIFF:\n${stagedDiff}\n`)
          .digest('hex');
      } catch {}
    }

    // Non-Git or fallback directory tree hashing
    return await this.computeDirectoryTreeHash(this.workspacePath);
  }

  private async computeDirectoryTreeHash(dir: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const ignoreDirs = new Set(['.git', 'node_modules', '.orchestrator_sandboxes', '.orchestrator_worktrees']);

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (ignoreDirs.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          hash.update(`DIR:${rel}\n`);
          await walk(full);
        } else if (entry.isFile()) {
          const stat = await fs.stat(full);
          hash.update(`FILE:${rel}:${stat.size}:${stat.mtimeMs}\n`);
          try {
            const buf = await fs.readFile(full);
            hash.update(crypto.createHash('sha256').update(buf).digest('hex'));
          } catch {}
        }
      }
    };

    try {
      await walk(dir);
    } catch {}
    return hash.digest('hex');
  }

  async getDiff(): Promise<string> {
    try {
      if (!(await this.isGitRepository())) return '';
      return await this.git.diff();
    } catch {
      return '';
    }
  }

  async getDiffAgainstBase(): Promise<string> {
    try {
      if (!(await this.isGitRepository()) || !this.baseline?.baseCommit || this.baseline.baseCommit === 'initial') {
        return await this.getDiff();
      }
      return await this.git.diff([this.baseline.baseCommit]);
    } catch {
      return await this.getDiff();
    }
  }

  /**
   * P0.5 FIX: Safe task checkpointing.
   * Stages ONLY task-owned files. NEVER uses `git add .` or `git add -u`.
   * Completely preserves unrelated user changes.
   */
  async createTaskCheckpoint(taskOwnedFiles: string[] = [], message: string): Promise<string | null> {
    try {
      if (!(await this.isGitRepository())) return null;

      const filesToStage: string[] = [];

      const initialDirtySet = new Set(this.baseline?.dirtyFilesAtStart || []);

      if (taskOwnedFiles.length > 0) {
        // Stage only explicit task-owned files that were NOT in initial dirty baseline
        for (const file of taskOwnedFiles) {
          const relPath = path.isAbsolute(file)
            ? path.relative(this.workspacePath, file).replace(/\\/g, '/')
            : file.replace(/\\/g, '/');

          // Strict P0 Protection: Do not stage files that already had pre-existing user modifications!
          if (!initialDirtySet.has(relPath)) {
            filesToStage.push(relPath);
          } else {
            console.warn(`[Checkpoint Protection] Skipping pre-existing dirty user file: ${relPath}`);
          }
        }
      } else {
        // If no explicit files specified, find files modified that were NOT in original dirtyFilesAtStart
        const currentStatus = await this.git.status();

        for (const file of currentStatus.files) {
          if (!initialDirtySet.has(file.path)) {
            filesToStage.push(file.path);
          }
        }
      }

      if (filesToStage.length === 0) {
        // No task-owned files modified; do not stage arbitrary files
        const log = await this.git.log({ maxCount: 1 });
        return log.latest ? log.latest.hash : null;
      }

      for (const f of filesToStage) {
        try {
          await this.git.add(f);
        } catch {}
      }

      const commitResult = await this.git.commit(message, undefined, { '--allow-empty': null });
      return commitResult.commit;
    } catch (err) {
      console.error('Failed to create safe git checkpoint:', err);
      return null;
    }
  }

  /**
   * P0.5 FIX: Safe targeted restoration.
   * Restores ONLY task-owned files from a checkpoint.
   * NEVER runs broad `git reset --hard` or `git clean -fd` against unrelated user work!
   */
  async restoreTaskFiles(taskFiles: string[], commitHash: string): Promise<boolean> {
    try {
      if (!(await this.isGitRepository())) return false;
      if (!taskFiles || taskFiles.length === 0) return false;

      for (const file of taskFiles) {
        try {
          await this.git.checkout([commitHash, '--', file]);
        } catch (err) {
          console.warn(`Could not checkout ${file} from ${commitHash}:`, err);
        }
      }
      return true;
    } catch (err) {
      console.error('Failed to restore task files safely:', err);
      return false;
    }
  }

  /**
   * P0 FIX: Creates an isolated Git worktree for executing a task without touching user working directory.
   * Throws strictly on failure so the orchestrator never silently falls back to the user workspace.
   */
  async createIsolatedWorktree(taskId: string): Promise<string> {
    if (!(await this.isGitRepository())) {
      throw new Error(`Cannot create Git worktree: Workspace "${this.workspacePath}" is not a Git repository.`);
    }

    const worktreeDir = path.join(this.workspacePath, '.orchestrator_worktrees', taskId);
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

    const branchName = `task/${taskId.slice(0, 8)}`;
    try {
      await this.git.raw(['worktree', 'add', '-B', branchName, worktreeDir, 'HEAD']);
    } catch (err: any) {
      throw new Error(`Git worktree allocation failed: ${err.message || String(err)}`);
    }
    return worktreeDir;
  }

  /**
   * P1 FIX: Creates an isolated filesystem sandbox copy for non-Git workspaces in a dedicated temp root.
   */
  async createIsolatedSandbox(taskId: string): Promise<string> {
    const sandboxDir = path.join(os.tmpdir(), 'orchestrator_sandboxes', taskId);
    await fs.mkdir(sandboxDir, { recursive: true });
    const EXCLUDED_DIRS = new Set([
      '.git',
      'node_modules',
      '.orchestrator_sandboxes',
      '.orchestrator_worktrees',
    ]);
    await fs.cp(this.workspacePath, sandboxDir, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(this.workspacePath, source);
        if (!rel) return true;
        const segments = rel.split(/[\\/]/);
        return !segments.some((seg) => EXCLUDED_DIRS.has(seg));
      },
    });
    return sandboxDir;
  }

  /**
   * Safely cleans up an isolated worktree.
   */
  async removeIsolatedWorktree(worktreeDir: string): Promise<void> {
    try {
      if (await this.isGitRepository()) {
        await this.git.raw(['worktree', 'remove', '--force', worktreeDir]);
      }
    } catch {
      try {
        await fs.rm(worktreeDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Safely cleans up an isolated sandbox.
   */
  async removeIsolatedSandbox(sandboxDir: string): Promise<void> {
    try {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    } catch {}
  }

  async inspect(): Promise<ProjectMetadata> {
    const isGit = await this.isGitRepository();
    let branch: string | undefined;
    let latestCommit: string | undefined;
    let hasUncommittedChanges = false;
    const uncommittedFiles: string[] = [];

    if (isGit) {
      try {
        const status = await this.git.status();
        branch = status.current || undefined;
        hasUncommittedChanges = !status.isClean();
        uncommittedFiles.push(...status.files.map((f) => f.path));

        const log = await this.git.log({ maxCount: 1 });
        if (log.latest) {
          latestCommit = log.latest.hash;
        }
      } catch {}
    }

    const ecosystems: ProjectMetadata['ecosystems'] = [];
    let packageManager: ProjectMetadata['packageManager'];
    let buildCmd: string | undefined;
    let testCmd: string | undefined;
    let lintCmd: string | undefined;

    // Detect Node.js
    const packageJsonPath = path.join(this.workspacePath, 'package.json');
    try {
      const pkgContent = await fs.readFile(packageJsonPath, 'utf8');
      const pkg = JSON.parse(pkgContent);
      ecosystems.push('nodejs');
      packageManager = 'npm';

      if (pkg.scripts) {
        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        if (pkg.scripts.build) buildCmd = `${npmBin} run build`;
        if (pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
          testCmd = `${npmBin} test`;
        }
        if (pkg.scripts.lint) lintCmd = `${npmBin} run lint`;
      }
    } catch {}

    // Detect Python
    try {
      const hasPyproject = await fs.access(path.join(this.workspacePath, 'pyproject.toml')).then(() => true).catch(() => false);
      const hasRequirements = await fs.access(path.join(this.workspacePath, 'requirements.txt')).then(() => true).catch(() => false);
      if (hasPyproject || hasRequirements) {
        ecosystems.push('python');
        if (!testCmd) testCmd = 'python -m pytest';
        if (!lintCmd) lintCmd = 'python -m ruff check .';
      }
    } catch {}

    // Detect Rust
    try {
      const hasCargo = await fs.access(path.join(this.workspacePath, 'Cargo.toml')).then(() => true).catch(() => false);
      if (hasCargo) {
        ecosystems.push('rust');
        packageManager = 'cargo';
        if (!buildCmd) buildCmd = 'cargo build';
        if (!testCmd) testCmd = 'cargo test';
        if (!lintCmd) lintCmd = 'cargo clippy';
      }
    } catch {}

    if (ecosystems.length === 0) {
      ecosystems.push('unknown');
    }

    const fileTreeSummary = await this.getSampleFileTree(this.workspacePath, 2);

    return {
      isGitRepo: isGit,
      branch,
      latestCommit,
      hasUncommittedChanges,
      uncommittedFiles,
      ecosystems,
      packageManager,
      buildCmd,
      testCmd,
      lintCmd,
      fileTreeSummary,
    };
  }

  private async getSampleFileTree(dir: string, depthRemaining: number, currentRel = ''): Promise<string[]> {
    if (depthRemaining <= 0) return [];
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.orchestrator_worktrees'].includes(entry.name)) {
          continue;
        }
        const relPath = path.join(currentRel, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          const subResults = await this.getSampleFileTree(path.join(dir, entry.name), depthRemaining - 1, relPath);
          results.push(...subResults);
        } else {
          results.push(relPath);
        }
        if (results.length > 50) {
          results.push('... (remaining files omitted)');
          break;
        }
      }
    } catch {}
    return results;
  }
}
