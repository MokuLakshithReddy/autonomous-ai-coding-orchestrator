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
        defaultImage = process.env.CONTAINER_SANDBOX_AIDER_IMAGE || 'paulgauthier/aider:latest';
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
        defaultImage = process.env.CONTAINER_SANDBOX_AIDER_IMAGE || 'paulgauthier/aider:latest';
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

    // P0 FIX (Issue 5 & CI): Kernel-level container boundary secret protection using cross-platform bind mounts.
    // Mount empty read-only placeholder over any sensitive files in the workspace so processes/agents inside container cannot exfiltrate them.
    try {
      const sensitiveFilesToCheck = [
        '.env', '.env.local', '.env.development', '.env.production', '.env.test',
        'credentials.json', 'id_rsa', 'id_ed25519', 'service_account.json'
      ];
      const emptyMaskFile = this.getEmptySecretMaskFile().replace(/\\/g, '/');
      for (const sf of sensitiveFilesToCheck) {
        const fullP = path.join(canonicalWorkspace, sf);
        if (fs.existsSync(fullP)) {
          dockerArgs.push('--mount', `type=bind,source=${emptyMaskFile},target=/workspace/${sf},readonly`);
        }
      }
    } catch {}

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
