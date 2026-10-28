/**
 * scripts/set-secret.ts
 *
 * Secure GitHub Actions Repository Secret Provisioning Tool.
 *
 * Minimum Token Permissions Required:
 * - Fine-grained Personal Access Token: "Repository permissions" -> "Secrets" (Read and Write)
 * - Classic Personal Access Token: "repo" scope (for private repositories) or "public_repo" (for public repositories)
 */

import https from 'node:https';
import readline from 'node:readline';
import sodium from 'tweetsodium';

const owner = process.env.GITHUB_OWNER || 'MokuLakshithReddy';
const repo = process.env.GITHUB_REPO || 'autonomous-ai-coding-orchestrator';

/**
 * Validates secret name against GitHub Actions naming constraints:
 * - Only alphanumeric characters ([a-z], [A-Z], [0-9]) and underscores (_)
 * - Cannot exceed 100 characters
 * - Cannot start with GITHUB_ prefix (reserved by GitHub)
 * - Cannot start with a number
 */
export function validateSecretName(name: string): void {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Secret name must be a non-empty string.');
  }
  const trimmed = name.trim();
  if (trimmed.length > 100) {
    throw new Error(`Secret name "${trimmed}" exceeds GitHub maximum limit of 100 characters.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid secret name "${trimmed}". Secret names may only contain alphanumeric characters ([a-zA-Z0-9]) and underscores, and cannot start with a number.`);
  }
  if (trimmed.toUpperCase().startsWith('GITHUB_')) {
    throw new Error(`Secret name "${trimmed}" cannot start with "GITHUB_" (reserved prefix by GitHub Actions).`);
  }
}

export interface HttpTransport {
  get: typeof https.get;
  request: typeof https.request;
}

export async function setGitHubSecret(
  secretName: string,
  secretValue: string,
  customToken?: string,
  options?: { transport?: HttpTransport }
): Promise<boolean> {
  const token = customToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) {
    throw new Error('Authentication required: GITHUB_TOKEN or GH_TOKEN environment variable must be provided.');
  }

  // 1. Validate Secret Name
  validateSecretName(secretName);

  if (!secretValue || !secretValue.trim()) {
    throw new Error('Secret value cannot be empty.');
  }

  const httpClient = options?.transport || https;

  // 2. Fetch repository public key
  const pubKeyData = await new Promise<{ key_id: string; key: string }>((resolve, reject) => {
    const req = httpClient.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/actions/secrets/public-key`,
        headers: {
          'User-Agent': 'NodeJS',
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(d);
              if (!parsed.key_id || !parsed.key) {
                return reject(new Error('Malformed response: Repository public key payload missing key_id or key.'));
              }
              resolve(parsed);
            } catch (err: any) {
              reject(new Error(`Malformed JSON in public key response: ${err.message}`));
            }
          } else if (res.statusCode === 401) {
            reject(new Error('GitHub API Error (401 Unauthorized): Invalid or expired token.'));
          } else if (res.statusCode === 403) {
            reject(new Error('GitHub API Error (403 Forbidden): Token lacks "repo" or "secrets:write" permission, or API rate limit exceeded.'));
          } else if (res.statusCode === 404) {
            reject(new Error(`GitHub API Error (404 Not Found): Repository "${owner}/${repo}" not found or token has insufficient access.`));
          } else {
            reject(new Error(`Failed to fetch repository public key: HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', reject);
  });

  // 3. Encrypt secret value using tweetsodium
  const messageBytes = Buffer.from(secretValue.trim());
  const keyBytes = Buffer.from(pubKeyData.key, 'base64');
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

  // 4. Put encrypted secret to GitHub API
  const payload = JSON.stringify({
    encrypted_value: encryptedValue,
    key_id: pubKeyData.key_id,
  });

  return new Promise<boolean>((resolve, reject) => {
    const req = httpClient.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(secretName.trim())}`,
        method: 'PUT',
        headers: {
          'User-Agent': 'NodeJS',
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode === 201 || res.statusCode === 204) {
          resolve(true);
        } else if (res.statusCode === 401) {
          reject(new Error('GitHub API Error (401 Unauthorized): Authentication failed.'));
        } else if (res.statusCode === 403) {
          reject(new Error('GitHub API Error (403 Forbidden): Insufficient token scope to write repository secrets.'));
        } else if (res.statusCode === 404) {
          reject(new Error(`GitHub API Error (404 Not Found): Target repository "${owner}/${repo}" does not exist.`));
        } else {
          let errData = '';
          res.on('data', (c) => (errData += c));
          res.on('end', () => reject(new Error(`Failed to set secret: HTTP ${res.statusCode}`)));
        }
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Securely read secret from stdin (piped input or hidden interactive prompt)
 */
async function readSecretSecurely(promptMsg: string): Promise<string> {
  // If not a TTY, read all of stdin (e.g. cat key.txt | tsx scripts/set-secret.ts GEMINI_API_KEY)
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data.trim()));
      process.stdin.on('error', reject);
    });
  }

  // Interactive TTY masked input
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    process.stdout.write(promptMsg);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    let secret = '';
    const onData = (char: Buffer) => {
      const s = char.toString('utf-8');
      if (s === '\n' || s === '\r' || s === '\u0004') {
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(secret.trim());
      } else if (s === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else if (s === '\b' || s === '\x7f') {
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
        }
      } else {
        secret += s;
      }
    };

    process.stdin.on('data', onData);
  });
}

// CLI Execution Handler
if (process.argv[1]?.endsWith('set-secret.ts')) {
  // Security guard: Reject secrets passed via CLI argument
  if (process.argv[3]) {
    console.error('\n❌ SECURITY ERROR: Do not pass secret values as command-line arguments!');
    console.error('Passing secrets in CLI arguments exposes them to process tables and shell history.');
    console.error('Usage: tsx scripts/set-secret.ts <secretName>');
    console.error('  - Pipe secret via stdin: echo -n "secret" | tsx scripts/set-secret.ts <secretName>');
    console.error('  - Or run interactively: tsx scripts/set-secret.ts <secretName>\n');
    process.exit(1);
  }

  const secretName = process.argv[2];
  if (!secretName) {
    console.error('Usage: tsx scripts/set-secret.ts <secretName>');
    process.exit(1);
  }

  try {
    validateSecretName(secretName);
  } catch (err: any) {
    console.error(`Validation Error: ${err.message}`);
    process.exit(1);
  }

  (async () => {
    const secretValue = await readSecretSecurely(`Enter value for secret "${secretName}": `);
    if (!secretValue) {
      console.error('Error: Empty secret value received. Aborted.');
      process.exit(1);
    }

    await setGitHubSecret(secretName, secretValue);
    console.log(`✓ Secret "${secretName}" encrypted and successfully registered in GitHub Actions repository secrets.`);
  })().catch((err) => {
    console.error('Error setting secret:', err.message);
    process.exit(1);
  });
}
