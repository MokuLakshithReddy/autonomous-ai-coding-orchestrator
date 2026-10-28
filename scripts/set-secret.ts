import https from 'node:https';
import readline from 'node:readline';
import sodium from 'tweetsodium';

const owner = process.env.GITHUB_OWNER || 'MokuLakshithReddy';
const repo = process.env.GITHUB_REPO || 'autonomous-ai-coding-orchestrator';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

export async function setGitHubSecret(secretName: string, secretValue: string): Promise<boolean> {
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN environment variable is required to authenticate with GitHub API.');
  }
  if (!secretValue || !secretValue.trim()) {
    throw new Error('Secret value cannot be empty.');
  }

  // 1. Get repository public key
  const pubKeyData = await new Promise<{ key_id: string; key: string }>((resolve, reject) => {
    const req = https.get(
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
            resolve(JSON.parse(d));
          } else {
            reject(new Error(`Failed to fetch repository public key: HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', reject);
  });

  // 2. Encrypt secret value using tweetsodium
  const messageBytes = Buffer.from(secretValue.trim());
  const keyBytes = Buffer.from(pubKeyData.key, 'base64');
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

  // 3. Put encrypted secret to GitHub API
  const payload = JSON.stringify({
    encrypted_value: encryptedValue,
    key_id: pubKeyData.key_id,
  });

  return new Promise<boolean>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/actions/secrets/${secretName}`,
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
    // Disable stdout echo for secret input
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
