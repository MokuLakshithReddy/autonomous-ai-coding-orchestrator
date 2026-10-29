import { spawn } from 'node:child_process';
import { SecurityPolicyEngine } from './policy.js';

export type ContainerCommandTarget =
  | { type: 'shell'; commandStr: string }
  | { type: 'exec'; executable: string; args: string[] };

export interface ContainerSandboxOptions {
  enabled?: boolean;
  image?: string;
  networkMode?: 'none' | 'host' | 'bridge';
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

  static async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    return new Promise((resolve) => {
      const child = spawn('docker', ['--version'], { shell: false, windowsHide: true });
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
    if (normalizedTarget.type === 'exec') {
      const execName = normalizedTarget.executable.toLowerCase();
      if (['aider', 'python', 'python3', 'pytest', 'pip'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_PYTHON_IMAGE || 'python:3.11-slim';
      } else if (['cargo', 'rustc'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_RUST_IMAGE || 'rust:1.80-slim';
      } else if (['go'].some((p) => execName.includes(p))) {
        defaultImage = process.env.CONTAINER_SANDBOX_GO_IMAGE || 'golang:1.23-bookworm';
      }
    } else {
      const cmd = normalizedTarget.commandStr.toLowerCase();
      if (cmd.includes('pytest') || cmd.includes('python ') || cmd.includes('pip ')) {
        defaultImage = process.env.CONTAINER_SANDBOX_PYTHON_IMAGE || 'python:3.11-slim';
      } else if (cmd.includes('cargo ')) {
        defaultImage = process.env.CONTAINER_SANDBOX_RUST_IMAGE || 'rust:1.80-slim';
      } else if (cmd.includes('go test') || cmd.includes('go build')) {
        defaultImage = process.env.CONTAINER_SANDBOX_GO_IMAGE || 'golang:1.23-bookworm';
      }
    }
    const image = options.image || process.env.CONTAINER_SANDBOX_IMAGE || defaultImage;
    const network = options.networkMode || 'none';
    const user = options.user || '1000:1000';
    const canonicalWorkspace = SecurityPolicyEngine.resolveCanonicalPath(workspacePath);

    // Strict containment arguments: drop capabilities, no host credential mounts, isolated workspace
    const dockerArgs = [
      'run',
      '--rm',
      '--network', network,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-u', user,
      '-v', `${canonicalWorkspace}:/workspace:rw`,
      '-w', '/workspace',
      '-e', 'CI=true',
      '-e', 'NODE_ENV=development',
    ];

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

    // P0 FIX: Preserve argument boundaries directly for exec targets without shell concatenation
    if (normalizedTarget.type === 'exec') {
      dockerArgs.push(normalizedTarget.executable, ...normalizedTarget.args);
    } else {
      dockerArgs.push('/bin/sh', '-c', normalizedTarget.commandStr);
    }

    return { executable: 'docker', args: dockerArgs };
  }
}
