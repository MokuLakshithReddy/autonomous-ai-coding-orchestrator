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
   * Resolves the canonical path of a target, even if the destination file or intermediate
   * directories do not exist yet. Traverses up to the nearest existing ancestor,
   * canonicalizes it with native realpath, and appends the non-existent trail.
   */
  static resolveCanonicalPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    let current = resolved;
    const segments: string[] = [];

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      segments.unshift(path.basename(current));
      current = parent;
    }

    let canonicalAncestor = current;
    try {
      if (fs.existsSync(current)) {
        canonicalAncestor = fs.realpathSync.native(current);
      }
    } catch {}

    return segments.length > 0 ? path.join(canonicalAncestor, ...segments) : canonicalAncestor;
  }

  /**
   * Platform-aware filesystem case-sensitivity check.
   * Windows and macOS are case-insensitive by default.
   * Linux and POSIX filesystems are case-sensitive.
   */
  static isCaseInsensitivePlatform(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  /**
   * Checks whether childPath is contained inside parentPath, preserving exact case
   * on case-sensitive filesystems (Linux / POSIX) to prevent case-variant directory bypasses.
   */
  static isPathInside(childPath: string, parentPath: string, forceCaseSensitive = false): boolean {
    const normChild = path.normalize(childPath);
    const normParent = path.normalize(parentPath);
    const isCaseInsensitive = !forceCaseSensitive && this.isCaseInsensitivePlatform();

    const c = isCaseInsensitive ? normChild.toLowerCase() : normChild;
    const p = isCaseInsensitive ? normParent.toLowerCase() : normParent;

    if (c === p) return true;
    const pWithSep = p.endsWith(path.sep) ? p : p + path.sep;
    return c.startsWith(pWithSep);
  }

  /**
   * P0 FIX: Validates authorization to use a repository workspace root.
   * Enforced across Server, CLI, and internal OrchestrationEngine entry points.
   */
  static validateWorkspaceAuthorization(
    workspacePath: string,
    allowedRoots: string[] = config.allowedWorkspaces,
    options?:
      | {
          allowUnrestricted?: boolean;
          forceCaseSensitive?: boolean;
        }
      | boolean
  ): string {
    if (!workspacePath || workspacePath.trim() === '') {
      throw new Error('Security Exception: Workspace path cannot be empty or unspecified.');
    }
    if (workspacePath.includes('\0')) {
      throw new Error('Security Exception: Null byte injection detected in workspace path.');
    }

    const resolved = path.resolve(workspacePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Security Exception: Workspace directory does not exist: "${resolved}".`);
    }

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = fs.realpathSync.native(resolved);
    } catch (err: any) {
      throw new Error(`Security Exception: Cannot resolve canonical workspace path "${resolved}": ${err.message}`);
    }

    const forceCaseSensitive =
      typeof options === 'boolean' ? options : options?.forceCaseSensitive ?? false;
    const allowUnrestricted =
      typeof options === 'object' && options?.allowUnrestricted !== undefined
        ? options.allowUnrestricted
        : config.allowUnrestrictedWorkspaces;

    if (allowedRoots && allowedRoots.length > 0) {
      const isAuthorized = allowedRoots.some((allowedRoot) => {
        try {
          const canonicalRoot = this.resolveCanonicalPath(allowedRoot);
          return this.isPathInside(canonicalWorkspace, canonicalRoot, forceCaseSensitive);
        } catch {
          return false;
        }
      });

      if (!isAuthorized) {
        throw new Error(
          `Security Exception [Workspace Forbidden]: Workspace path "${canonicalWorkspace}" is not within authorized workspace roots: [${allowedRoots.join(
            ', '
          )}]`
        );
      }
    } else {
      // Empty or unspecified allowed roots: Default is RESTRICTED (fail-closed)
      if (!allowUnrestricted) {
        throw new Error(
          `Security Exception [Workspace Forbidden]: Workspace authorization failed. Allowed workspace roots list is empty and unrestricted workspace operation is disabled. Configure ALLOWED_DIRECTORIES or explicitly enable unrestricted mode.`
        );
      }
    }

    return canonicalWorkspace;
  }

  /**
   * P0 FIX: Enforces platform-aware canonical containment within the task's execution workspace.
   * Preserves case on POSIX/Linux to block case-variant sibling directory escapes.
   * Resolves symlinks and handles non-existent destination paths via ancestor resolution.
   */
  static assertPathContainment(targetPath: string, workspacePath: string, forceCaseSensitive = false): string {
    if (!targetPath || !workspacePath) {
      throw new Error('Security Exception: Target path and workspace path must be non-empty strings.');
    }
    if (targetPath.includes('\0') || workspacePath.includes('\0')) {
      throw new Error('Security Exception: Null byte injection detected in path.');
    }

    const canonicalWorkspace = this.resolveCanonicalPath(workspacePath);
    const resolvedTarget = path.resolve(canonicalWorkspace, targetPath);
    const canonicalTarget = this.resolveCanonicalPath(resolvedTarget);

    const isInside = this.isPathInside(canonicalTarget, canonicalWorkspace, forceCaseSensitive);
    if (!isInside) {
      throw new Error(
        `Security Exception [Path Traversal Blocked]: Attempted access to "${targetPath}" resolves to "${canonicalTarget}", which is outside authorized workspace "${canonicalWorkspace}".`
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
    const combined = `${actionDescription} ${commandOrPath || ''}`.trim();
    const lower = combined.toLowerCase();

    // 1. Critical operations
    if (
      /\b(git\s+push\s+.*--force|deploy|publish|production|drop\s+database|format\s+[a-z]:|rm\s+-rf\s+[\/\\]|dd\s+if=)/i.test(
        lower
      )
    ) {
      return {
        riskLevel: 'CRITICAL',
        requiresApproval: true,
        reason: 'Potentially destructive or irreversible operation targeting external or production systems.',
      };
    }

    // 2. Destructive actions: deletion, drop table, clean
    if (
      /\b(rm\s+|del\s+|delete\s+file|unlink|drop\s+table|delete\s+from|git\s+clean\s+-fd)\b/i.test(lower)
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: 'Action involves file deletion or high-impact state mutation.',
      };
    }

    // 3. Sensitive destinations
    if (commandOrPath && this.isSensitiveDestination(commandOrPath)) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: `Action targets sensitive credential or configuration: ${commandOrPath}`,
      };
    }

    return {
      riskLevel: 'LOW',
      requiresApproval: false,
    };
  }

  /**
   * P0 FIX: Strict execution-layer command authorization.
   * Treats pattern matching as defense-in-depth and enforces a narrow safe policy (fail-closed):
   * 1. Blocks command composition, pipelines, subshells, and redirection without approval.
   * 2. Permits only an explicitly defined safe allowlist of build, test, and inspection tools.
   * 3. Defaults all unrecognized, alternative, or compound commands to requiring operator approval.
   */
  static evaluateCommandRisk(command: string): ActionPolicy {
    const text = command.trim();
    const lower = text.toLowerCase();

    // 1. Critical operations: deployments, forced pushes, system formatting
    if (
      /\b(git\s+push\s+.*--force|deploy|publish|production|drop\s+database|format\s+[a-z]:|rm\s+-rf\s+[\/\\]|dd\s+if=)/i.test(
        lower
      )
    ) {
      return {
        riskLevel: 'CRITICAL',
        requiresApproval: true,
        reason: 'Potentially destructive or irreversible operation targeting external or production systems.',
      };
    }

    // 2. Shell composition, command chaining, piping, redirection, and subshell injection
    // E.g., `npm test; rm -rf /`, `npm test && echo bypass`, `cmd | sh`, `script > file`
    if (/[;&|><`$\r\n]/.test(text)) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: 'Shell composition, pipeline, redirection, or subshell chaining operator detected.',
      };
    }

    // 3. Dynamic interpreters, obfuscation, and unconstrained script evaluation
    if (
      /\b(python(\d)?\s+(-c|-m)|node\s+-e|perl\s+-e|ruby\s+-e|php\s+-r|eval\b|base64|iex\b)/i.test(
        lower
      ) ||
      /(?:^|\s)(powershell(\.exe)?|pwsh(\.exe)?|bash|sh|zsh|cmd(\.exe)?)(?:\s|$)/i.test(
        lower
      )
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: 'Dynamic interpreter, shell invocation, or encoded evaluation detected.',
      };
    }

    // 4. File deletions, state wipes, privilege alterations
    if (
      /\b(rm|del|unlink|rmdir|git\s+reset|git\s+clean|chmod|chown|curl|wget|npm\s+publish)\b/i.test(
        lower
      )
    ) {
      return {
        riskLevel: 'HIGH',
        requiresApproval: true,
        reason: 'Operation involves file deletion or high-impact state mutation.',
      };
    }

    // 5. Narrow Safe Policy Allowlist: Only atomic, non-destructive tools
    const isSafeGit = /^git\s+(status|diff|log|show|branch|rev-parse)(\s+.*)?$/i.test(lower);
    const isSafeBuildTest =
      /^(npm|npm\.cmd|pnpm|yarn)\s+(run\s+)?(build|test|lint)(\s+.*)?$/i.test(lower) ||
      /^(npx|npx\.cmd)\s+(tsc|jest|vitest|eslint|prettier)(\s+.*)?$/i.test(lower) ||
      /^(tsc|tsc\.cmd)(\s+.*)?$/i.test(lower) ||
      /^(python|python3)\s+-m\s+(pytest|unittest)(\s+.*)?$/i.test(lower) ||
      /^pytest(\s+.*)?$/i.test(lower) ||
      /^cargo\s+(test|build|check|clippy)(\s+.*)?$/i.test(lower) ||
      /^go\s+(test|build)(\s+.*)?$/i.test(lower) ||
      /^node(\.exe)?\s+[a-zA-Z0-9_\-\.\/\\]+\.(js|mjs|cjs)(\s+.*)?$/i.test(lower);

    if (isSafeGit) {
      return {
        riskLevel: 'LOW',
        requiresApproval: false,
      };
    }

    if (isSafeBuildTest) {
      return {
        riskLevel: 'MODERATE',
        requiresApproval: false,
      };
    }

    // 6. Fail-Closed Default: Any command outside the narrow safe policy requires explicit operator approval
    return {
      riskLevel: 'HIGH',
      requiresApproval: true,
      reason: `Command "${text}" is outside the narrow safe execution policy and requires explicit operator authorization.`,
    };
  }
}
