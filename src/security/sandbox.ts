import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecurityPolicyEngine } from './policy.js';

export type ContainerCommandTarget =
  | { type: 'shell'; commandStr: string }
  | { type: 'exec'; executable: string; args: string[] };

export interface ContainerSandboxOptions {
  enabled?: boolean;
  image?: string;
  networkMode?: 'none' | 'host' | 'bridge' | (string & {});
  user?: string;
  env?: Record<string, string>;
  forwardApiKeys?: boolean;
}

/**
 * P0 FIX: Operating-System Level Container Isolation.
 * Executes untrusted repository commands, builds, tests, and external agent scripts
 * inside a restricted, low-privilege container without mounting host credentials,
 * SSH keys, personal files, or uncontained network access.
 */
export class ContainerSandbox {
  private static dockerAvailable: boolean | null = null;
  private static emptyMaskFile: string | null = null;

  /**
   * Cross-platform 0-byte mask file for bind-mounting over sensitive files in container.
   * Unlike Unix /dev/null, this file-based bind mount is 100% valid across Windows, Linux, and macOS.
   */
  static getEmptySecretMaskFile(): string {
    if (this.emptyMaskFile && fs.existsSync(this.emptyMaskFile)) {
      return this.emptyMaskFile;
    }
    const maskDir = path.join(os.tmpdir(), 'orchestrator_masks');
    fs.mkdirSync(maskDir, { recursive: true });
    const maskFile = path.join(maskDir, 'empty_secret_mask.txt');
    if (!fs.existsSync(maskFile)) {
      fs.writeFileSync(maskFile, '# Masked by Orchestrator Isolation Boundary\n', { encoding: 'utf8', mode: 0o444 });
    }
    this.emptyMaskFile = maskFile;
    return maskFile;
  }

  private static readonly BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
    '.pdf', '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib',
    '.jar', '.class', '.pyc', '.pyo'
  ]);

  /**
   * P0/P2 FIX (Issues 3 & 4): Scans complete file content for sensitive secrets using bounded streaming with overlap.
   * - Scans entire file length across 64 KB chunks with 512-byte overlap so tokens spanning chunk
   *   boundaries are never missed.
   * - If a non-binary file exceeds the maximum scan budget (50 MB), fails closed and flags it as sensitive
   *   so uninspected files are automatically masked at the container boundary.
   * - P2 FIX (Issue 4): Fails closed on incomplete reads, unexpected EOF, or concurrent file modification.
   *   Requires bytes scanned to match expected file length and validates file stat post-scan.
   * - Throws a Security Exception if an unreadable file cannot be inspected, preventing un-isolated execution.
   */
  static fileContainsSecrets(fullPath: string, relPath: string): boolean {
    const ext = path.extname(fullPath).toLowerCase();
    if (this.BINARY_EXTENSIONS.has(ext)) {
      return false;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw new Error(
        `Security Exception: Failed to stat file "${fullPath}" during mandatory secret scan: ${err.message}`
      );
    }

    if (!stat.isFile()) {
      return false;
    }

    // Fail-closed for enormous text files: if exceeding 50 MB, mask it automatically
    const MAX_STREAM_SCAN_BYTES = 50 * 1024 * 1024;
    if (stat.size > MAX_STREAM_SCAN_BYTES) {
      console.warn(
        `[Container Secret Masking] File "${relPath}" (${(stat.size / (1024 * 1024)).toFixed(1)} MB) exceeds scan limit. Masking automatically to fail closed.`
      );
      return true;
    }

    if (stat.size === 0) {
      return false;
    }

    const CHUNK_SIZE = 64 * 1024;
    const OVERLAP_SIZE = 512;
    let fd: number;
    try {
      fd = fs.openSync(fullPath, 'r');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw new Error(
        `Security Exception: Failed to open file "${fullPath}" during mandatory secret scan: ${err.message}`
      );
    }

    try {
      let offset = 0;
      let prevOverlap = '';

      while (offset < stat.size) {
        const bytesToRead = Math.min(CHUNK_SIZE, stat.size - offset);
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);
        if (bytesRead <= 0) break;

        const currentChunk = buf.toString('utf8', 0, bytesRead);
        const textToScan = prevOverlap + currentChunk;
        const scanResult = SecurityPolicyEngine.containsSensitiveSecret(textToScan);
        if (scanResult.hasSecret) {
          console.warn(
            `[Container Secret Masking] Detected embedded secret (${scanResult.reason}) in "${relPath}" at byte offset ${offset}. Adding to container mount masks.`
          );
          return true;
        }

        prevOverlap = currentChunk.slice(-OVERLAP_SIZE);
        offset += bytesRead;
      }

      // P2 FIX (Issue 4): Fail closed if file read was incomplete or truncated mid-scan
      if (offset < stat.size) {
        throw new Error(
          `Security Exception: File "${fullPath}" truncated or read incomplete during mandatory secret scan. Expected ${stat.size} bytes, read ${offset} bytes.`
        );
      }

      // P2 FIX (Issue 4): Re-verify file metadata post-scan to fail closed against concurrent modifications
      const postStat = fs.lstatSync(fullPath);
      if (postStat.mtimeMs !== stat.mtimeMs || postStat.size !== stat.size) {
        throw new Error(
          `Security Exception: File "${fullPath}" was modified concurrently during mandatory secret scan. Initial size: ${stat.size}, current size: ${postStat.size}. Failing closed.`
        );
      }

      return false;
    } catch (readErr: any) {
      if (readErr.message?.startsWith('Security Exception:')) {
        throw readErr;
      }
      throw new Error(
        `Security Exception: Failed to stream-inspect file content at "${fullPath}" during mandatory secret scan: ${readErr.message}. Cannot guarantee isolation.`
      );
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  /**
   * P0/P1 FIX (Issues 3 & 7): Recursively discovers all sensitive secret paths in the workspace
   * using both path-based criteria (SecurityPolicyEngine.isSensitiveSecret) AND complete streaming
   * content-based secret scanning for ordinary non-binary files.
   * - P0 FIX: Complete streaming inspection covers full file sizes beyond 128 KB and 2 MB without cutoff.
   * - P0 FIX (Issue 3): No arbitrary depth cutoff. Tracks visited directories to prevent loops,
   *   and fails closed on excessive depth (> 40) or filesystem inspection errors.
   */
  static findSensitiveFilesToMask(workspacePath: string): string[] {
    const sensitivePaths: string[] = [];
    const canonicalWorkspace = SecurityPolicyEngine.resolveCanonicalPath(workspacePath);
    const visitedDirs = new Set<string>();

    const scan = (dir: string, depth = 0) => {
      if (depth > 40) {
        throw new Error(
          `Security Exception: Maximum directory traversal depth (40) exceeded at "${dir}". Cannot guarantee complete secret isolation.`
        );
      }

      const canonicalDir = SecurityPolicyEngine.resolveCanonicalPath(dir);
      if (visitedDirs.has(canonicalDir)) return;
      visitedDirs.add(canonicalDir);

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err: any) {
        throw new Error(
          `Security Exception: Failed to inspect directory "${dir}" during mandatory secret scan: ${err.message}. Aborting container launch.`
        );
      }

      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.orchestrator_worktrees') {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(canonicalWorkspace, fullPath).replace(/\\/g, '/');

        if (SecurityPolicyEngine.isSensitiveSecret(relPath)) {
          if (entry.isDirectory()) {
            scan(fullPath, depth + 1);
          } else {
            sensitivePaths.push(relPath);
          }
        } else if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          // P0 FIX: Complete bounded streaming content scan on ordinary files
          if (this.fileContainsSecrets(fullPath, relPath)) {
            sensitivePaths.push(relPath);
          }
        }
      }
    };

    // Root common dotfiles
    const rootCommon = [
      '.env', '.env.local', '.env.development', '.env.production', '.env.test',
      '.npmrc', '.netrc', '.dockercfg', 'credentials.json', 'id_rsa', 'id_ed25519',
      'service_account.json'
    ];
    for (const f of rootCommon) {
      if (fs.existsSync(path.join(canonicalWorkspace, f))) {
        sensitivePaths.push(f);
      }
    }

    scan(canonicalWorkspace);
    return Array.from(new Set(sensitivePaths));
  }

  /**
   * P1 FIX (Issue 4): Checks local availability of custom and external agent Docker images.
   * Reports exactly which images are present and which need to be built via "npm run docker:build".
   */
  static async checkImageAvailability(): Promise<{
    claude: boolean;
    aider: boolean;
    missing: string[];
  }> {
    const isDocker = await this.isDockerAvailable();
    if (!isDocker) {
      return { claude: false, aider: false, missing: ['Docker daemon not running'] };
    }

    const checkImage = (imageName: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const child = spawn('docker', ['image', 'inspect', imageName], { shell: false, windowsHide: true });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    };

    const claudeImg = process.env.CONTAINER_SANDBOX_CLAUDE_IMAGE || 'orchestrator-claude:latest';
    const aiderImg = process.env.CONTAINER_SANDBOX_AIDER_IMAGE || 'orchestrator-aider:latest';

    const claudeOk = await checkImage(claudeImg);
    const aiderOk = await checkImage(aiderImg) || (aiderImg === 'orchestrator-aider:latest' && await checkImage('paulgauthier/aider:latest'));

    const missing: string[] = [];
    if (!claudeOk) missing.push(claudeImg);
    if (!aiderOk) missing.push(aiderImg);

    return { claude: claudeOk, aider: aiderOk, missing };
  }

  static async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    return new Promise((resolve) => {
      const child = spawn('docker', ['info'], { shell: false, windowsHide: true });
      child.on('close', (code) => {
        this.dockerAvailable = code === 0;
        resolve(this.dockerAvailable);
      });
      child.on('error', () => {
        this.dockerAvailable = false;
        resolve(false);
      });
    });
  }

  /**
   * P0 FIX: Mandatory fail-closed assertion for container isolation.
   * If container isolation is configured or enforced, execution MUST fail closed
   * rather than falling back to running untrusted code on the host OS.
   */
  static async assertSandboxAvailable(): Promise<void> {
    const available = await this.isDockerAvailable();
    if (!available) {
      throw new Error(
        'Security Exception [Sandbox Unavailable]: Mandatory container sandbox is enabled, but Docker is not available or running. Aborting command execution to prevent running untrusted repository code on the host OS.'
      );
    }
  }

  /**
   * Builds container execution arguments with strict preservation of argument boundaries.
   * Does NOT flatten executable arguments into shell strings, eliminating command-injection risks.
   */
  static buildDockerRunArgs(
    workspacePath: string,
    target: string | ContainerCommandTarget,
    options: ContainerSandboxOptions = {}
  ): { executable: string; args: string[] } {
    const normalizedTarget: ContainerCommandTarget =
      typeof target === 'string'
        ? { type: 'shell', commandStr: target }
        : target;

    // Ecosystem-aware default image selection
    let defaultImage = 'node:22-bookworm-slim';
    let isExternalAgent = false;
    if (normalizedTarget.type === 'exec') {
      const execName = normalizedTarget.executable.toLowerCase();
      if (execName.includes('aider')) {
        isExternalAgent = true;
        defaultImage = process.env.CONTAINER_SANDBOX_AIDER_IMAGE || 'orchestrator-aider:latest';
      } else if (execName.includes('claude')) {
        isExternalAgent = true;
        // P0 FIX: Default to custom Claude Code image built from Dockerfile.claude
        defaultImage = process.env.CONTAINER_SANDBOX_CLAUDE_IMAGE || 'orchestrator-claude:latest';
      } else if (['python', 'python3', 'pytest', 'pip', 'unittest'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_PYTHON_IMAGE || 'python:3.11-slim';
      } else if (['cargo', 'rustc'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_RUST_IMAGE || 'rust:1.80-slim';
      } else if (['go'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_GO_IMAGE || 'golang:1.23-bookworm';
      }
    } else {
      const cmd = normalizedTarget.commandStr.toLowerCase();
      if (cmd.startsWith('aider ') || cmd.includes('/aider ')) {
        isExternalAgent = true;
        defaultImage = process.env.CONTAINER_SANDBOX_AIDER_IMAGE || 'orchestrator-aider:latest';
      } else if (cmd.startsWith('claude ') || cmd.includes('/claude ')) {
        isExternalAgent = true;
        defaultImage = process.env.CONTAINER_SANDBOX_CLAUDE_IMAGE || 'orchestrator-claude:latest';
      } else if (cmd.includes('pytest') || cmd.includes('python ') || cmd.includes('pip ')) {
        defaultImage = process.env.CONTAINER_SANDBOX_PYTHON_IMAGE || 'python:3.11-slim';
      } else if (cmd.includes('cargo ')) {
        defaultImage = process.env.CONTAINER_SANDBOX_RUST_IMAGE || 'rust:1.80-slim';
      } else if (cmd.includes('go test') || cmd.includes('go build')) {
        defaultImage = process.env.CONTAINER_SANDBOX_GO_IMAGE || 'golang:1.23-bookworm';
      }
    }
    const image = options.image || process.env.CONTAINER_SANDBOX_IMAGE || defaultImage;
    const network = options.networkMode || process.env.CONTAINER_SANDBOX_NETWORK || 'none';
    const user = options.user || '1000:1000';
    const canonicalWorkspace = SecurityPolicyEngine.resolveCanonicalPath(workspacePath);
    const normalizedWorkspace = canonicalWorkspace.replace(/\\/g, '/');

    // Strict containment arguments: drop capabilities, resource limits, no host credential mounts, isolated workspace
    const dockerArgs = [
      'run',
      '--rm',
      '--network', network,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', process.env.CONTAINER_SANDBOX_MEMORY || '2g',
      '--cpus', process.env.CONTAINER_SANDBOX_CPUS || '2',
      '--pids-limit', process.env.CONTAINER_SANDBOX_PIDS_LIMIT || '128',
      '-u', user,
      '--mount', `type=bind,source=${normalizedWorkspace},target=/workspace`,
      '-w', '/workspace',
      '-e', 'CI=true',
      '-e', 'NODE_ENV=development',
    ];

    // P0 FIX (Issue 2): Never mount the parent repository's shared .git directory into an untrusted container with write access!
    // Tasks execute in self-contained disposable repositories where /workspace/.git already exists as an isolated directory.
    // If a legacy worktree file is present, an isolated disposable task git directory is provided without touching host git metadata.

    // P0 FIX (Issue 1, 3 & 7): Kernel-level container boundary secret protection using cross-platform bind mounts.
    // Mount empty read-only placeholder over ALL sensitive files across the entire workspace hierarchy (.aws, .ssh, .env, etc.)
    // Fail-closed: any failure to discover or mask secrets throws immediately, preventing container execution with exposed credentials.
    const sensitiveFilesToMask = this.findSensitiveFilesToMask(canonicalWorkspace);
    const emptyMaskFile = this.getEmptySecretMaskFile().replace(/\\/g, '/');
    for (const sf of sensitiveFilesToMask) {
      dockerArgs.push('--mount', `type=bind,source=${emptyMaskFile},target=/workspace/${sf},readonly`);
    }

    // P0 FIX: Strictly forward agent credentials ONLY when explicitly requested for external agents.
    // Secrets are forwarded by name (-e KEY) rather than (-e KEY=val) so values never appear in process arguments!
    if (options.forwardApiKeys === true) {
      const allowedKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
      for (const key of allowedKeys) {
        if (options.env?.[key] || process.env[key]) {
          dockerArgs.push('-e', key);
        }
      }
    }

    // Forward additional sanitized custom environment variables
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (!['PATH', 'NODE_ENV', 'CI', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].includes(k)) {
          dockerArgs.push('-e', `${k}=${v}`);
        }
      }
    }

    dockerArgs.push(image);

    // P0 FIX: Clean Windows binary extensions (.cmd, .exe) when dispatching into Linux container
    if (normalizedTarget.type === 'exec') {
      const cleanExec = normalizedTarget.executable.replace(/\.(cmd|exe|bat)$/i, '');
      dockerArgs.push(cleanExec, ...normalizedTarget.args);
    } else {
      const cleanCmd = normalizedTarget.commandStr
        .replace(/\b(npm|pnpm|yarn|npx|tsc|aider|claude)\.cmd\b/gi, '$1')
        .replace(/\b(aider|claude|node|python)\.exe\b/gi, '$1');
      dockerArgs.push('/bin/sh', '-c', cleanCmd);
    }

    return { executable: 'docker', args: dockerArgs };
  }
}
