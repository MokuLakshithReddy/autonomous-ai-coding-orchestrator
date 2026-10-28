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
   * Enforces strict canonical containment within the authorized workspace.
   * Resolves symlinks and prevents path traversal (e.g. `../` escapes, case collisions).
   */
  static assertPathContainment(targetPath: string, workspacePath: string): string {
    const resolvedWorkspace = path.resolve(workspacePath);
    const resolvedTarget = path.resolve(resolvedWorkspace, targetPath);

    // Canonicalize realpaths if path exists, or canonicalize directory tree
    let canonicalWorkspace = resolvedWorkspace;
    try {
      if (fs.existsSync(resolvedWorkspace)) {
        canonicalWorkspace = fs.realpathSync.native(resolvedWorkspace);
      }
    } catch {}

    let canonicalTarget = resolvedTarget;
    try {
      if (fs.existsSync(resolvedTarget)) {
        canonicalTarget = fs.realpathSync.native(resolvedTarget);
      } else {
        // Resolve parent realpath for non-existent target files
        const parentDir = path.dirname(resolvedTarget);
        if (fs.existsSync(parentDir)) {
          canonicalTarget = path.join(fs.realpathSync.native(parentDir), path.basename(resolvedTarget));
        }
      }
    } catch {}

    const relative = path.relative(canonicalWorkspace, canonicalTarget);
    const isEscaped = relative.startsWith('..') || path.isAbsolute(relative);

    if (isEscaped) {
      throw new Error(
        `Security Exception [Path Traversal Blocked]: Attempted access to "${targetPath}" is outside authorized workspace "${workspacePath}".`
      );
    }

    // Check configured allowedWorkspaces restriction if present
    if (config.allowedWorkspaces && config.allowedWorkspaces.length > 0) {
      const isAllowed = config.allowedWorkspaces.some((allowed) => {
        const rel = path.relative(allowed, canonicalTarget);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!isAllowed) {
        throw new Error(
          `Security Exception [Workspace Policy]: Path "${canonicalTarget}" is not within configured ALLOWED_DIRECTORIES.`
        );
      }
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
   * Evaluates action risk level for planning milestones or step instructions.
   */
  static evaluateActionRisk(actionDescription: string, commandOrPath?: string): ActionPolicy {
    return this.evaluateCommandRisk(`${actionDescription} ${commandOrPath || ''}`);
  }

  /**
   * Enforces risk evaluation at the actual command execution boundary.
   */
  static evaluateCommandRisk(command: string): ActionPolicy {
    const text = command.toLowerCase().trim();

    // Critical operations: deployments, forced pushes, system formatting
    if (
      /\b(git\s+push\s+.*--force|deploy|publish|production|drop\s+database|format\s+[a-z]:|rm\s+-rf\s+[\/\\]|dd\s+if=)\b/i.test(
        text
      )
    ) {
      return {
        riskLevel: 'CRITICAL',
        requiresApproval: true,
        reason: 'Potentially destructive or irreversible operation targeting external or production systems.',
      };
    }

    // High risk: protected branch mutations, deleting files, permission alteration, system changes
    if (
      /\b(rm\s+|del\s+|unlink\s+|rmdir\s+|git\s+reset|git\s+clean|chmod\s+|chown\s+|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|npm\s+publish)\b/i.test(
        text
      )
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: config.requireApprovalForDestructive,
        reason: 'Modification involves file deletion or high-impact state mutation.',
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
