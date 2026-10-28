import fs from 'node:fs/promises';
import path from 'node:path';
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
   * Safe checkpoint: stages only the specified task-owned files instead of blind `git add .`
   */
  async createTaskCheckpoint(taskOwnedFiles: string[], message: string): Promise<string | null> {
    try {
      if (!(await this.isGitRepository())) return null;

      if (taskOwnedFiles.length > 0) {
        // Stage only task owned files
        for (const file of taskOwnedFiles) {
          try {
            await this.git.add(file);
          } catch {}
        }
      } else {
        // If no explicit files specified, stage modified tracked files without untracked user files
        await this.git.add(['-u']);
      }

      const commitResult = await this.git.commit(message, undefined, { '--allow-empty': null });
      return commitResult.commit;
    } catch (err) {
      console.error('Failed to create safe git checkpoint:', err);
      return null;
    }
  }

  /**
   * Safe targeted restoration: Restores ONLY task-owned files from a checkpoint.
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
        if (pkg.scripts.build) buildCmd = 'npm.cmd run build';
        if (pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
          testCmd = 'npm.cmd test';
        }
        if (pkg.scripts.lint) lintCmd = 'npm.cmd run lint';
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
        if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'].includes(entry.name)) {
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
