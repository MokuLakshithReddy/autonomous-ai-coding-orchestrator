import { spawn } from 'node:child_process';
import { SecurityPolicyEngine } from './policy.js';

export interface ContainerSandboxOptions {
  enabled?: boolean;
  image?: string;
  networkMode?: 'none' | 'host' | 'bridge';
  user?: string;
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

  static buildDockerRunArgs(
    workspacePath: string,
    command: string,
    options: ContainerSandboxOptions = {}
  ): { executable: string; args: string[] } {
    const image = options.image || 'node:22-alpine';
    const network = options.networkMode || 'none';
    const user = options.user || '1000:1000';
    const canonicalWorkspace = SecurityPolicyEngine.resolveCanonicalPath(workspacePath);

    // Strict containment arguments: drop capabilities, no host credential mounts, isolated workspace
    const args = [
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
      image,
      '/bin/sh', '-c', command,
    ];

    return { executable: 'docker', args };
  }
}

