import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config/index.js';

export type ActionRiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface ActionPolicy {
  riskLevel: ActionRiskLevel;
  requiresApproval: boolean;
  reason?: string;
}

export class SecurityPolicyEngine {
  public static readonly SAFE_ENV_VARS = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'HOME',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'NODE_ENV',
    'CI',
    'EDITOR',
    'GIT_EXEC_PATH',
  ]);

  /**
   * P1 FIX: Enforces strict canonical containment within the authorized workspace.
   * Resolves symlinks and prevents path traversal (e.g. `../` escapes, junctions, null bytes).
   */
  static assertPathContainment(targetPath: string, workspacePath: string): string {
    if (!targetPath || !workspacePath) {
      throw new Error('Security Exception: Target path and workspace path must be non-empty strings.');
    }
    if (targetPath.includes('\0') || workspacePath.includes('\0')) {
      throw new Error('Security Exception: Null byte injection detected in path.');
    }

    const resolvedWorkspace = path.resolve(workspacePath);
    let canonicalWorkspace = resolvedWorkspace;
    try {
      if (fs.existsSync(resolvedWorkspace)) {
        canonicalWorkspace = fs.realpathSync.native(resolvedWorkspace);
      }
    } catch {}

    const resolvedTarget = path.resolve(canonicalWorkspace, targetPath);
    let canonicalTarget = resolvedTarget;
    try {
      if (fs.existsSync(resolvedTarget)) {
        canonicalTarget = fs.realpathSync.native(resolvedTarget);
      } else {
        const parentDir = path.dirname(resolvedTarget);
        if (fs.existsSync(parentDir)) {
          canonicalTarget = path.join(fs.realpathSync.native(parentDir), path.basename(resolvedTarget));
        }
      }
    } catch {}

    const normTarget = path.normalize(canonicalTarget).toLowerCase();
    const normWorkspace = path.normalize(canonicalWorkspace).toLowerCase();

    const isInside = normTarget === normWorkspace || normTarget.startsWith(normWorkspace + path.sep);
    if (!isInside) {
      throw new Error(
        `Security Exception [Path Traversal Blocked]: Attempted access to "${targetPath}" is outside authorized workspace "${workspacePath}".`
      );
    }

    return canonicalTarget;
  }

  /**
   * Returns a sanitized environment variable map.
   * Validates custom variables against an explicit allowlist and blocks secret patterns.
   */
  static getSanitizedProcessEnv(customEnv: Record<string, string> = {}): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined && this.SAFE_ENV_VARS.has(key.toUpperCase())) {
        sanitized[key] = val;
      }
    }

    sanitized['CI'] = 'true';
    sanitized['NODE_ENV'] = sanitized['NODE_ENV'] || 'development';

    // Validate and merge only safe, explicitly allowed custom environment variables
    for (const [k, v] of Object.entries(customEnv)) {
      const upperKey = k.toUpperCase();
      const isDangerousKey =
        upperKey.includes('KEY') ||
        upperKey.includes('SECRET') ||
        upperKey.includes('TOKEN') ||
        upperKey.includes('PASSWORD') ||
        upperKey.includes('CREDENTIAL') ||
        upperKey.includes('AUTH') ||
        upperKey.includes('PRIVATE');

      if (v !== undefined && !isDangerousKey) {
        if (this.SAFE_ENV_VARS.has(upperKey) || upperKey.startsWith('TASK_') || upperKey.startsWith('APP_')) {
          sanitized[k] = v;
        }
      }
    }

    return sanitized;
  }

  /**
   * Redacts credentials, tokens, and private keys from strings and logs.
   */
  static redactSensitiveData(input: string): string {
    if (!input) return '';

    return input
      // GitHub personal access tokens
      .replace(/ghp_[A-Za-z0-9_]{36,}/g, '[REDACTED_GH_TOKEN]')
      .replace(/github_pat_[A-Za-z0-9_]{50,}/g, '[REDACTED_GH_PAT]')
      // Google API keys
      .replace(/AIza[0-9A-Za-z\-_]{30,}/g, '[REDACTED_GEMINI_KEY]')
      // OpenAI API keys
      .replace(/sk-[a-zA-Z0-9_\-]{32,}/g, '[REDACTED_API_KEY]')
      // Generic Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_TOKEN]')
      // Private RSA / SSH keys
      .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[^-]+-----END (?:RSA )?PRIVATE KEY-----/gs, '[REDACTED_PRIVATE_KEY]');
  }

  /**
   * P0 FIX: Checks if a destination path targets sensitive credentials or security configurations.
   */
  static isSensitiveDestination(filePath: string): boolean {
    const normalized = filePath.toLowerCase().replace(/\\/g, '/');
    const base = path.basename(normalized);
    return (
      base.startsWith('.env') ||
      base.includes('credential') ||
      base.includes('id_rsa') ||
      base.endsWith('.pem') ||
      base.endsWith('.key') ||
      normalized.includes('.git/') ||
      normalized.includes('.github/workflows') ||
      base === 'sudoers' ||
      base === 'passwd' ||
      base === 'shadow'
    );
  }

  /**
   * P0 FIX: Evaluates authorization risk for writing or modifying file destinations.
   */
  static evaluateFileWriteRisk(filePath: string): ActionPolicy {
    if (this.isSensitiveDestination(filePath)) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: `Destination "${filePath}" is a sensitive credential or security configuration file.`,
      };
    }
    return {
      riskLevel: 'LOW',
      requiresApproval: false,
    };
  }

  /**
   * Evaluates action risk level for planning milestones or step instructions.
   */
  static evaluateActionRisk(actionDescription: string, commandOrPath?: string): ActionPolicy {
    return this.evaluateCommandRisk(`${actionDescription} ${commandOrPath || ''}`);
  }

  /**
   * Enforces risk evaluation at the actual command execution boundary.
   * Intercepts destructive commands, interpreters, and dynamic script runners.
   */
  static evaluateCommandRisk(command: string): ActionPolicy {
    const text = command.toLowerCase().trim();

    // Critical operations: deployments, forced pushes, system formatting
    if (
      /\b(git\s+push\s+.*--force|deploy|publish|production|drop\s+database|format\s+[a-z]:|rm\s+-rf\s+[\/\\]|dd\s+if=)/i.test(
        text
      )
    ) {
      return {
        riskLevel: 'CRITICAL',
        requiresApproval: true,
        reason: 'Potentially destructive or irreversible operation targeting external or production systems.',
      };
    }

    // High risk: protected branch mutations, deleting files, permission alteration, system tampering
    if (
      /\b(rm|del|unlink|rmdir|git\s+reset|git\s+clean|chmod|chown|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|npm\s+publish)\b/i.test(
        text
      )
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: config.requireApprovalForDestructive,
        reason: 'Modification involves file deletion or high-impact state mutation.',
      };
    }

    // P0 FIX: High risk: dynamic interpreters and unconstrained script execution
    if (
      /\b(python(\d)?\s+(-c|-m)|node\s+-e|perl\s+-e|ruby\s+-e|php\s+-r|powershell(\.exe)?\s+.*(-enc|-c|-command)|pwsh(\.exe)?\s+.*(-enc|-c|-command)|eval\b|base64\s+-d|iex\b)/i.test(
        text
      )
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: config.requireApprovalForDestructive,
        reason: 'Dynamic interpreter execution or encoded script execution detected.',
      };
    }

    // Moderate risk: file modification, installing dependencies, local build & test runs
    if (/\b(npm\s+install|pnpm\s+add|pip\s+install|cargo\s+add|npm\s+run|npm\s+test|npx\s+|tsc|pytest)\b/i.test(text)) {
      return {
        riskLevel: 'MODERATE',
        requiresApproval: false,
      };
    }

    // Low risk: read operations, inspection, git status, diff
    return {
      riskLevel: 'LOW',
      requiresApproval: false,
    };
  }
}
