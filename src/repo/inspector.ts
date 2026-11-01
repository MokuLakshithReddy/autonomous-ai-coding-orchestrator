import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { SecurityPolicyEngine } from '../security/policy.js';
import { ContainerSandbox } from '../security/sandbox.js';

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

/**
 * P1 FIX: Matches exact internal orchestrator directories or subpaths under them.
 * Does NOT match user-owned paths such as .orchestrator_worktrees_backup or .orchestrator_sandboxes_notes.
 */
export function isInternalOrchestratorPath(filePath: string): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    norm === '.orchestrator_worktrees' ||
    norm.startsWith('.orchestrator_worktrees/') ||
    norm === '.orchestrator_sandboxes' ||
    norm.startsWith('.orchestrator_sandboxes/')
  );
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
      const status = await this.git.status();
      // P1 FIX: Filter out exact internal orchestrator directories without catching user paths
      status.files = status.files.filter((f) => !isInternalOrchestratorPath(f.path));
      return status;
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
   * Policy for allowable ephemeral verification side-effects (build outputs, coverage, test caches)
   */
  private static readonly EPHEMERAL_IGNORED_PATTERNS = [
    /^(dist|build|coverage|\.nyc_output|\.turbo|\.next|\.cache|\.temp|\.tmp|__pycache__|\.pytest_cache)([\\/]|$)/i,
    /\.(log|tmp|tsbuildinfo|cache|pyc|pyo|pyd)$/i,
  ];

  /**
   * P0 FIX: Exhaustive Workspace State Fingerprinting.
   * Guarantees that ANY file modification during verification is detected:
   * 1. Tracked Files: HEAD commit + git status + working diff + staged diff.
   * 2. Untracked Files & Directories: Discovered via NUL-delimited (-z) status;
   *    preserves literal paths with spaces, quotes, and special characters;
   *    content SHA-256, size, mtime, and symlink targets hashed recursively.
   * 3. Ignored Files & Directories: Non-ephemeral ignored paths are recursively hashed;
   *    detects file mutations deep inside ignored directories without status line changes.
   * 4. Symlinks: Resolved with readlink to prevent symlink retargeting attacks.
   * 5. Non-Git Fallback: Full directory tree hash with symlink and content verification.
   */
  async getWorkspaceFingerprint(): Promise<string> {
    if (await this.isGitRepository()) {
      try {
        const headCommit = (await this.getCurrentCommitHash()) || 'NO_HEAD';
        // Use -z to guarantee unquoted, literal filenames with spaces, quotes, and special characters
        const porcelain = await this.git.raw(['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching']);
        const workingDiff = await this.git.diff();
        const stagedDiff = await this.git.diff(['--cached']);

        const hasher = crypto.createHash('sha256');
        hasher.update(`HEAD:${headCommit}\n`);
        hasher.update(`PORCELAIN:\n${porcelain}\n`);
        hasher.update(`WORKING_DIFF:\n${workingDiff}\n`);
        hasher.update(`STAGED_DIFF:\n${stagedDiff}\n`);

        const records = porcelain.split('\0').filter(Boolean);
        const untrackedPaths: string[] = [];
        const nonEphemeralIgnoredPaths: string[] = [];

        for (const record of records) {
          if (record.startsWith('?? ')) {
            const rawPath = record.slice(3).replace(/\/+$/, '');
            const norm = rawPath.replace(/\\/g, '/');
            const isEphemeral = RepoInspector.EPHEMERAL_IGNORED_PATTERNS.some(
              (pat) => pat.test(norm) || pat.test(path.basename(norm))
            );
            if (!isEphemeral && rawPath) untrackedPaths.push(rawPath);
          } else if (record.startsWith('!! ')) {
            const rawPath = record.slice(3).replace(/\/+$/, '');
            const norm = rawPath.replace(/\\/g, '/');
            const isEphemeral = RepoInspector.EPHEMERAL_IGNORED_PATTERNS.some(
              (pat) => pat.test(norm) || pat.test(path.basename(norm))
            );
            if (!isEphemeral && norm) {
              nonEphemeralIgnoredPaths.push(rawPath);
            }
          }
        }

        untrackedPaths.sort();
        for (const relPath of untrackedPaths) {
          const fullPath = path.join(this.workspacePath, relPath);
          await this.hashPathRecursively(fullPath, `UNTRACKED:${relPath}`, hasher);
        }

        nonEphemeralIgnoredPaths.sort();
        for (const relPath of nonEphemeralIgnoredPaths) {
          const fullPath = path.join(this.workspacePath, relPath);
          await this.hashPathRecursively(fullPath, `IGNORED:${relPath}`, hasher);
        }

        return hasher.digest('hex');
      } catch {}
    }

    // Non-Git or fallback directory tree hashing
    return await this.computeDirectoryTreeHash(this.workspacePath);
  }

  /**
   * Recursively hashes files, symlinks, and directories.
   * Traverses into ignored directories and content-hashes all files within them.
   */
  private async hashPathRecursively(fullPath: string, label: string, hasher: crypto.Hash): Promise<void> {
    try {
      const lstat = await fs.lstat(fullPath);
      if (lstat.isSymbolicLink()) {
        const linkTarget = await fs.readlink(fullPath);
        hasher.update(`SYMLINK:${label}->${linkTarget}\n`);
      } else if (lstat.isFile()) {
        hasher.update(`FILE:${label}:${lstat.size}:${lstat.mtimeMs}\n`);
        const content = await fs.readFile(fullPath);
        hasher.update(crypto.createHash('sha256').update(content).digest('hex'));
      } else if (lstat.isDirectory()) {
        const norm = label.replace(/\\/g, '/');
        const dirName = path.basename(fullPath);
        if (
          dirName === '.git' ||
          dirName === '.orchestrator_sandboxes' ||
          dirName === '.orchestrator_worktrees' ||
          RepoInspector.EPHEMERAL_IGNORED_PATTERNS.some((pat) => pat.test(norm) || pat.test(dirName))
        ) {
          return;
        }
        hasher.update(`DIR:${label}\n`);
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const childFull = path.join(fullPath, entry.name);
          const childLabel = `${label}/${entry.name}`;
          await this.hashPathRecursively(childFull, childLabel, hasher);
        }
      }
    } catch {
      hasher.update(`MISSING:${label}\n`);
    }
  }

  private async computeDirectoryTreeHash(dir: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const ignoreDirs = new Set(['.git', 'node_modules', '.orchestrator_sandboxes', '.orchestrator_worktrees']);

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (
          ignoreDirs.has(entry.name) ||
          RepoInspector.EPHEMERAL_IGNORED_PATTERNS.some((pat) => pat.test(entry.name))
        ) {
          continue;
        }
        const full = path.join(currentDir, entry.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          hash.update(`DIR:${rel}\n`);
          await walk(full);
        } else {
          await this.hashPathRecursively(full, rel, hash);
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

  async getDiffAgainstBase(explicitBaseCommit?: string): Promise<string> {
    const base = explicitBaseCommit || this.baseline?.baseCommit;
    try {
      if (!(await this.isGitRepository()) || !base || base === 'initial') {
        return await this.getDiff();
      }
      return await this.git.diff([base]);
    } catch {
      return await this.getDiff();
    }
  }

  /**
   * P1 FIX (Issue 1): Configures task-local author and committer identity for an isolated repository.
   * Inherits identity from parent repository if configured; falls back safely to default identity
   * so commits never fail even on systems without global Git configuration.
   */
  async configureTaskGitIdentity(targetDir: string): Promise<void> {
    let userName = 'Autonomous Orchestrator';
    let userEmail = 'orchestrator@local';
    try {
      const name = (await this.git.raw(['config', 'user.name'])).trim();
      if (name) userName = name;
    } catch {}
    try {
      const email = (await this.git.raw(['config', 'user.email'])).trim();
      if (email) userEmail = email;
    } catch {}

    try {
      const targetGit = simpleGit(targetDir);
      await targetGit.addConfig('user.name', userName, false, 'local');
      await targetGit.addConfig('user.email', userEmail, false, 'local');
    } catch (err: any) {
      console.warn(`[Git Identity] Could not configure local Git identity in "${targetDir}":`, err?.message);
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

      // P1 FIX (Issue 1): Ensure local commit identity is configured prior to committing
      try {
        const hasName = await this.git.raw(['config', 'user.name']).catch(() => '');
        if (!hasName.trim()) {
          await this.git.addConfig('user.name', 'Autonomous Orchestrator', false, 'local');
        }
        const hasEmail = await this.git.raw(['config', 'user.email']).catch(() => '');
        if (!hasEmail.trim()) {
          await this.git.addConfig('user.email', 'orchestrator@local', false, 'local');
        }
      } catch {}

      const filesToStage: string[] = [];

      const normalizedWorkspace = this.workspacePath.replace(/\\/g, '/');
      const isIsolatedWorktree =
        normalizedWorkspace.includes('/.orchestrator_worktrees/') ||
        normalizedWorkspace.endsWith('/.orchestrator_worktrees') ||
        normalizedWorkspace.includes('/.orchestrator_sandboxes/') ||
        normalizedWorkspace.endsWith('/.orchestrator_sandboxes');
      const initialDirtySet = isIsolatedWorktree
        ? new Set<string>()
        : new Set(this.baseline?.dirtyFilesAtStart || []);

      if (taskOwnedFiles.length > 0) {
        // Stage only explicit task-owned files that were NOT in initial dirty baseline (unless isolated worktree)
        for (const file of taskOwnedFiles) {
          const relPath = path.isAbsolute(file)
            ? path.relative(this.workspacePath, file).replace(/\\/g, '/')
            : file.replace(/\\/g, '/');

          // P1 FIX (Issue 2): NEVER stage sensitive secrets or credentials into task commits!
          if (SecurityPolicyEngine.isSensitiveSecret(relPath)) {
            console.warn(`[Checkpoint Protection] Skipping sensitive secret file from staging: ${relPath}`);
            continue;
          }

          // P1 FIX (Issue 3): Content-based secret detection - NEVER stage files containing embedded secrets!
          const fullPath = path.isAbsolute(file) ? file : path.join(this.workspacePath, file);
          if (ContainerSandbox.fileContainsSecrets(fullPath, relPath)) {
            console.warn(`[Checkpoint Protection] Skipping file containing embedded secrets from staging: ${relPath}`);
            continue;
          }

          // Strict P0 Protection: Do not stage files that already had pre-existing user modifications!
          if (isIsolatedWorktree || !initialDirtySet.has(relPath)) {
            filesToStage.push(relPath);
          } else {
            console.warn(`[Checkpoint Protection] Skipping pre-existing dirty user file: ${relPath}`);
          }
        }
      } else {
        // If no explicit files specified, find files modified that were NOT in original dirtyFilesAtStart
        const currentStatus = await this.git.status();

        for (const file of currentStatus.files) {
          // P1 FIX (Issue 2): NEVER stage sensitive secrets or credentials into task commits!
          if (SecurityPolicyEngine.isSensitiveSecret(file.path)) {
            console.warn(`[Checkpoint Protection] Skipping sensitive secret file from staging: ${file.path}`);
            continue;
          }

          // P1 FIX (Issue 3): Content-based secret detection - NEVER stage files containing embedded secrets!
          const fullPath = path.join(this.workspacePath, file.path);
          if (ContainerSandbox.fileContainsSecrets(fullPath, file.path)) {
            console.warn(`[Checkpoint Protection] Skipping file containing embedded secrets from staging: ${file.path}`);
            continue;
          }

          if (isIsolatedWorktree || !initialDirtySet.has(file.path)) {
            filesToStage.push(file.path);
          }
        }
      }

      if (filesToStage.length === 0) {
        // No task-owned files modified; do not stage arbitrary files
        const log = await this.git.log({ maxCount: 1 });
        return log.latest ? log.latest.hash : null;
      }

      // P1 FIX (Issue 1): Do not swallow individual staging errors. Fail closed on staging failure.
      for (const f of filesToStage) {
        try {
          await this.git.add(f);
        } catch (addErr: any) {
          throw new Error(`Failed to stage eligible file "${f}": ${addErr?.message || addErr}`);
        }
      }

      const commitResult = await this.git.commit(message, undefined, { '--allow-empty': null });

      // P1 FIX (Issue 1): Inspect post-commit status to verify that staged eligible files were committed
      const postStatus = await this.git.status();
      const stillUncommitted = postStatus.files.filter((f) => filesToStage.includes(f.path));
      if (stillUncommitted.length > 0) {
        console.warn(
          `[Checkpoint Verification] Staged files remain uncommitted after commit: ${stillUncommitted.map((f) => f.path).join(', ')}`
        );
        return null;
      }

      return commitResult.commit;
    } catch (err) {
      console.error('Failed to create safe git checkpoint:', err);
      return null;
    }
  }

  /**
   * P1 FIX: Dedicated safe recovery snapshot function.
   * Applies the exact same sensitive-file filtering and committer identity as normal checkpoints.
   * NEVER runs unrestricted `git add -A` against sensitive files or secrets.
   * Verifies that all eligible uncommitted files were committed; returns null if any remain so
   * orchestrator preserves/quarantines worktree safely.
   */
  async createSafeRecoverySnapshot(message: string): Promise<string | null> {
    try {
      if (!(await this.isGitRepository())) return null;
      const commit = await this.createTaskCheckpoint([], message);
      if (!commit) return null;

      // P1 FIX (Issue 1): Verify that all eligible files were actually committed.
      // If any eligible uncommitted files remain, return null so the worktree is quarantined.
      const currentStatus = await this.git.status();
      const uncommittedEligible = currentStatus.files.filter((file) => {
        if (SecurityPolicyEngine.isSensitiveSecret(file.path)) return false;
        const fullPath = path.join(this.workspacePath, file.path);
        if (ContainerSandbox.fileContainsSecrets(fullPath, file.path)) return false;
        return true;
      });

      if (uncommittedEligible.length > 0) {
        console.warn(
          `[Safe Recovery Snapshot] ${uncommittedEligible.length} eligible file(s) remain uncommitted after snapshot commit: ${uncommittedEligible.map((f) => f.path).join(', ')}. Marking snapshot incomplete to preserve worktree.`
        );
        return null;
      }

      return commit;
    } catch (err: any) {
      console.error(`[Safe Recovery Snapshot] Failed to create recovery snapshot: ${err?.message}`);
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

      let allSucceeded = true;
      for (const file of taskFiles) {
        try {
          await this.git.checkout([commitHash, '--', file]);
        } catch (err) {
          allSucceeded = false;
          console.warn(`Could not checkout ${file} from ${commitHash}:`, err);
        }
      }
      return allSucceeded;
    } catch (err) {
      console.error('Failed to restore task files safely:', err);
      return false;
    }
  }

  /**
   * P0 FIX: Creates an isolated Git worktree for executing a task without touching user working directory.
   * P1 FIX (Issue 2): Reuses existing task branch on resumption and NEVER overwrites with -B.
   * Throws strictly on failure so the orchestrator never silently falls back to the user workspace.
   */
  /**
   * P0/P1 FIX (Issues 1, 2, 4, 5): Creates an isolated task workspace or resumes an existing quarantined worktree.
   * - Uses lstat() to verify root and directory are not untrusted symlinks.
   * - Enforces canonical containment within authorized workspace.
   * - Validates existing repository and expected task branch prior to in-place recovery.
   * - Guarantees a 100% self-contained repository with independent .git directory (no broken worktree pointer files).
   * - Inherits and configures task-local author and committer Git identity.
   */
  async createIsolatedWorktree(taskId: string): Promise<string> {
    if (!(await this.isGitRepository())) {
      throw new Error(`Cannot create Git worktree: Workspace "${this.workspacePath}" is not a Git repository.`);
    }

    const canonicalWorkspace = SecurityPolicyEngine.resolveCanonicalPath(this.workspacePath);
    const worktreeRootDir = path.join(this.workspacePath, '.orchestrator_worktrees');
    const worktreeDir = path.join(worktreeRootDir, taskId);
    const branchName = `task/${taskId.slice(0, 8)}`;

    // P1 FIX (Issue 4): Safely validate worktree root directory against untrusted symlinks
    const rootLstat = await fs.lstat(worktreeRootDir).catch(() => null);
    if (rootLstat) {
      if (rootLstat.isSymbolicLink()) {
        throw new Error(
          `Security Exception: Worktree root directory "${worktreeRootDir}" is an untrusted symbolic link.`
        );
      }
    } else {
      await fs.mkdir(worktreeRootDir, { recursive: true });
    }

    // Ensure parent repo git excludes internal orchestrator worktree directories
    try {
      const gitDir = path.join(this.workspacePath, '.git');
      const excludeFile = path.join(gitDir, 'info', 'exclude');
      const infoStat = await fs.stat(path.dirname(excludeFile)).catch(() => null);
      if (infoStat) {
        let content = '';
        try { content = await fs.readFile(excludeFile, 'utf8'); } catch {}
        if (!content.includes('.orchestrator_worktrees')) {
          await fs.appendFile(excludeFile, '\n.orchestrator_worktrees\n.orchestrator_sandboxes\n', 'utf8');
        }
      }
    } catch {}

    // P1 FIX (Issue 4): Safely validate task worktree directory if it already exists
    const dirLstat = await fs.lstat(worktreeDir).catch(() => null);
    if (dirLstat) {
      if (dirLstat.isSymbolicLink()) {
        throw new Error(
          `Security Exception: Worktree directory "${worktreeDir}" is an untrusted symbolic link.`
        );
      }

      // Enforce canonical containment inside authorized workspace using platform-aware helper
      const canonicalWorktree = SecurityPolicyEngine.resolveCanonicalPath(worktreeDir);
      if (!SecurityPolicyEngine.isPathInside(canonicalWorktree, canonicalWorkspace)) {
        throw new Error(
          `Security Exception: Worktree directory "${worktreeDir}" resolves to "${canonicalWorktree}", outside authorized workspace "${canonicalWorkspace}".`
        );
      }

      // Validate that existing directory is a real, healthy Git repository on the expected branch
      const candidateGit = simpleGit(worktreeDir);
      const isRepo = await candidateGit.checkIsRepo().catch(() => false);
      if (isRepo) {
        const status = await candidateGit.status().catch(() => null);
        if (status && status.current === branchName) {
          console.log(`[Worktree Resumption] Reusing quarantined/existing worktree in-place on branch "${branchName}" at "${worktreeDir}".`);
          await this.configureTaskGitIdentity(worktreeDir);
          await this.sanitizeWorktreeSecrets(worktreeDir);
          return worktreeDir;
        }
      }

      // Directory exists but is not a valid Git repo or is on an unexpected branch; safely re-allocate
      console.warn(`[Worktree Recovery] Existing directory at "${worktreeDir}" is not a valid repository on branch "${branchName}". Removing and re-allocating...`);
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }

    // Clean up any stale worktree registration in git
    try {
      await this.git.raw(['worktree', 'prune']);
    } catch {}

    try {
      const branchList = await this.git.branchLocal();
      const branchExists = branchList.all.includes(branchName);

      if (!branchExists) {
        await this.git.branch([branchName, 'HEAD']);
      }

      // P1 FIX (Issue 5): Guarantee a 100% self-contained clone for container isolation.
      // Never fall back to git worktree add, which creates .git pointer files referencing
      // host parent metadata that is deliberately unmounted in container execution.
      try {
        await this.git.clone(this.workspacePath, worktreeDir, [
          '--local',
          '--branch', branchName,
          '--single-branch',
          '--no-tags',
        ]);
      } catch (cloneErr: any) {
        // Fallback: Manually initialize an independent repository and fetch the branch
        try {
          await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
          await fs.mkdir(worktreeDir, { recursive: true });
          const isolatedGit = simpleGit(worktreeDir);
          await isolatedGit.init();
          await isolatedGit.addRemote('origin', this.workspacePath);
          await isolatedGit.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/heads/${branchName}`]);
          await isolatedGit.checkout(branchName);
        } catch (initErr: any) {
          throw new Error(
            `Failed to allocate independent isolated repository for container execution: ${cloneErr?.message || cloneErr}. Init fallback also failed: ${initErr?.message || initErr}`
          );
        }
      }
    } catch (err: any) {
      throw new Error(`Git worktree allocation failed: ${err.message || String(err)}`);
    }

    // P1 FIX (Issue 1): Configure task-local Git identity on the cloned repository
    await this.configureTaskGitIdentity(worktreeDir);

    // P1 FIX (Issue 2): Sanitize worktree secrets without corrupting tracked files
    await this.sanitizeWorktreeSecrets(worktreeDir);

    return worktreeDir;
  }

  /**
   * P0/P1 FIX (Issues 2 & 3): Comprehensively sanitizes untracked secret files and untrusted symlinks.
   * - P1 FIX (Issue 2): NEVER overwrites tracked Git files to hide their contents. Tracked source files
   *   remain untouched so git working tree and task branch commits are never corrupted.
   *   Container isolation masks them safely via read-only bind mounts at the container boundary.
   * - P0 FIX (Issue 3): Traverses entire directory structure without arbitrary depth cutoff.
   *   Detects traversal loops via visited canonical paths; fails closed on excessive depth (> 40)
   *   or filesystem errors rather than silently suppressing them.
   */
  async sanitizeWorktreeSecrets(worktreeDir: string): Promise<void> {
    const canonicalWorktree = SecurityPolicyEngine.resolveCanonicalPath(worktreeDir);
    const placeholder = '# MASKED_BY_ORCHESTRATOR_ISOLATION\n# Real host secrets are prohibited inside isolated task workspaces.\n';

    // P1 FIX (Issue 2): Discover all files tracked by Git in the worktree. Fail closed on error.
    let trackedFiles = new Set<string>();
    const isGit = await simpleGit(canonicalWorktree).checkIsRepo().catch(() => false);
    if (isGit) {
      try {
        const wtGit = simpleGit(canonicalWorktree);
        const lsOutput = await wtGit.raw(['ls-files']);
        trackedFiles = new Set(
          lsOutput
            .split(/\r?\n/)
            .filter(Boolean)
            .map((f) => f.replace(/\\/g, '/'))
        );
      } catch (err: any) {
        throw new Error(
          `Security Exception: Failed to retrieve tracked files from Git in "${canonicalWorktree}": ${err.message}. Aborting sanitization to prevent corrupting tracked source files.`
        );
      }
    }

    const sanitizeEntry = async (fullPath: string, relPath: string) => {
      // P1 FIX (Issue 2): NEVER delete or overwrite tracked repository files or symlinks!
      // Tracked files and symlinks must remain intact in the clone so Git history and working tree are not corrupted.
      // Container isolation masks sensitive paths safely via read-only bind mounts at the container boundary.
      if (trackedFiles.has(relPath)) {
        return;
      }

      const lstat = await fs.lstat(fullPath);
      if (lstat.isSymbolicLink()) {
        // Untrusted untracked symlink detected (e.g. .env -> ../../../../etc/passwd)
        // NEVER follow symlink or write through it! Safely remove the untracked symlink:
        await fs.unlink(fullPath);
        await fs.writeFile(fullPath, placeholder, { encoding: 'utf8', flag: 'w' });
      } else if (lstat.isFile()) {
        // Verify canonical path containment before modifying untracked secret file
        const canonicalFile = SecurityPolicyEngine.resolveCanonicalPath(fullPath);
        if (canonicalFile.startsWith(canonicalWorktree + path.sep) || canonicalFile === canonicalWorktree) {
          await fs.writeFile(fullPath, placeholder, { encoding: 'utf8', flag: 'w' });
        }
      }
    };

    // Recursive directory walk matching SecurityPolicyEngine.isSensitiveSecret
    // P0 FIX (Issue 3): No arbitrary depth cutoff; throw on excessive depth or traversal errors (fail-closed)
    const visitedDirs = new Set<string>();
    const scanDir = async (currentDir: string, depth = 0) => {
      if (depth > 40) {
        throw new Error(
          `Security Exception: Maximum directory traversal depth (40) exceeded at "${currentDir}". Directory structure may be recursive or adversarial.`
        );
      }
      const canonicalDir = SecurityPolicyEngine.resolveCanonicalPath(currentDir);
      if (visitedDirs.has(canonicalDir)) return;
      visitedDirs.add(canonicalDir);

      let entries: any[] = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (err: any) {
        throw new Error(
          `Security Exception: Failed to read directory "${currentDir}" during mandatory secret sanitization: ${err.message}`
        );
      }

      for (const entry of entries) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.orchestrator_worktrees' ||
          entry.name === '.orchestrator_sandboxes'
        ) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(canonicalWorktree, fullPath).replace(/\\/g, '/');

        if (SecurityPolicyEngine.isSensitiveSecret(relPath)) {
          if (entry.isDirectory()) {
            await scanDir(fullPath, depth + 1);
          } else {
            await sanitizeEntry(fullPath, relPath);
          }
        } else if (entry.isDirectory()) {
          await scanDir(fullPath, depth + 1);
        }
      }
    };

    // 1. Direct check of root-level sensitive files & dotfiles
    const rootCommon = [
      '.env', '.env.local', '.env.development', '.env.production', '.env.test',
      '.npmrc', '.netrc', '.dockercfg', 'credentials.json', 'id_rsa', 'id_ed25519',
      'service_account.json'
    ];
    for (const f of rootCommon) {
      const p = path.join(canonicalWorktree, f);
      try {
        const stat = await fs.lstat(p).catch(() => null);
        if (stat) {
          await sanitizeEntry(p, f);
        }
      } catch (err: any) {
        throw new Error(`Security Exception: Failed to sanitize secret path "${p}": ${err.message}`);
      }
    }

    // 2. Full recursive scan across all nested files and sensitive directories
    await scanDir(canonicalWorktree);
  }

  /**
   * P1 FIX: Creates an isolated filesystem sandbox copy for non-Git workspaces in a dedicated temp root.
   * Excludes internal metadata and sensitive secret files (.env, credentials, private keys).
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
        if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return false;
        // P0 FIX: Exclude sensitive secrets and credentials from sandbox copies
        if (SecurityPolicyEngine.isSensitiveSecret(rel)) return false;
        return true;
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
        await this.git.raw(['worktree', 'prune']).catch(() => {});
      }
    } catch {
      try {
        await fs.rm(worktreeDir, { recursive: true, force: true });
        if (await this.isGitRepository()) {
          await this.git.raw(['worktree', 'prune']).catch(() => {});
        }
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

      // P1 FIX: Accurate Node package manager detection (pnpm, yarn, npm)
      const hasPnpmLock = await fs.access(path.join(this.workspacePath, 'pnpm-lock.yaml')).then(() => true).catch(() => false);
      const hasYarnLock = await fs.access(path.join(this.workspacePath, 'yarn.lock')).then(() => true).catch(() => false);
      const hasBunLock =
        (await fs.access(path.join(this.workspacePath, 'bun.lockb')).then(() => true).catch(() => false)) ||
        (await fs.access(path.join(this.workspacePath, 'bun.lock')).then(() => true).catch(() => false));

      if (hasPnpmLock || (pkg.packageManager && String(pkg.packageManager).startsWith('pnpm'))) {
        packageManager = 'pnpm';
      } else if (hasYarnLock || (pkg.packageManager && String(pkg.packageManager).startsWith('yarn'))) {
        packageManager = 'yarn';
      } else if (hasBunLock || (pkg.packageManager && String(pkg.packageManager).startsWith('bun'))) {
        packageManager = 'npm';
      } else {
        packageManager = 'npm';
      }

      if (pkg.scripts) {
        const isWin = process.platform === 'win32';
        const pmBin = isWin ? `${packageManager}.cmd` : packageManager;
        if (pkg.scripts.build) buildCmd = `${pmBin} run build`;
        if (pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
          testCmd = `${pmBin} test`;
        }
        if (pkg.scripts.lint) lintCmd = `${pmBin} run lint`;
      }
    } catch {}

    // Detect Python
    try {
      const hasPyproject = await fs.access(path.join(this.workspacePath, 'pyproject.toml')).then(() => true).catch(() => false);
      const hasRequirements = await fs.access(path.join(this.workspacePath, 'requirements.txt')).then(() => true).catch(() => false);
      const entries = await fs.readdir(this.workspacePath).catch(() => []);
      const hasPyFiles = entries.some((f) => f.endsWith('.py'));
      const hasTestsDir =
        (await fs.access(path.join(this.workspacePath, 'tests')).then(() => true).catch(() => false)) ||
        (await fs.access(path.join(this.workspacePath, 'test')).then(() => true).catch(() => false));

      if (hasPyproject || hasRequirements || hasPyFiles || hasTestsDir) {
        if (!ecosystems.includes('python')) ecosystems.push('python');
        const hasTestPy = entries.some((f) => /test_.*\.py$|.*_test\.py$/i.test(f));
        const hasPoetry = await fs.access(path.join(this.workspacePath, 'poetry.lock')).then(() => true).catch(() => false);
        if (hasPoetry) packageManager = 'poetry';
        else if (hasRequirements) packageManager = 'pip';

        if (!testCmd && (hasTestPy || hasTestsDir || hasPyproject || hasRequirements)) {
          testCmd = hasPoetry ? 'poetry run pytest' : 'python -m pytest';
        }
        const hasRuff =
          (await fs.access(path.join(this.workspacePath, 'ruff.toml')).then(() => true).catch(() => false)) ||
          (await fs.access(path.join(this.workspacePath, '.ruff.toml')).then(() => true).catch(() => false));
        if (hasRuff && !lintCmd) lintCmd = 'python -m ruff check .';
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

    // P2 FIX: Detect Go (golang)
    try {
      const hasGoMod = await fs.access(path.join(this.workspacePath, 'go.mod')).then(() => true).catch(() => false);
      if (hasGoMod) {
        ecosystems.push('golang');
        packageManager = 'go';
        if (!buildCmd) buildCmd = 'go build ./...';
        if (!testCmd) testCmd = 'go test ./...';
        if (!lintCmd) lintCmd = 'golangci-lint run';
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
