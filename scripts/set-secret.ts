import https from 'node:https';
import sodium from 'tweetsodium';

const owner = process.env.GITHUB_OWNER || 'MokuLakshithReddy';
const repo = process.env.GITHUB_REPO || 'autonomous-ai-coding-orchestrator';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

export async function setGitHubSecret(secretName: string, secretValue: string): Promise<boolean> {
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
            reject(new Error(`Failed to fetch public key: ${res.statusCode} ${d}`));
          }
        });
      }
    );
    req.on('error', reject);
  });

  // 2. Encrypt secret value using tweetsodium
  const messageBytes = Buffer.from(secretValue);
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
          res.on('end', () => reject(new Error(`Failed to set secret: ${res.statusCode} ${errData}`)));
        }
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Allow running from CLI: tsx scripts/set-secret.ts <secretName> <secretValue>
if (process.argv[1]?.endsWith('set-secret.ts') && process.argv[2] && process.argv[3]) {
  const secretName = process.argv[2];
  const secretValue = process.argv[3];
  setGitHubSecret(secretName, secretValue)
    .then(() => console.log(`✓ Successfully stored secret "${secretName}" in GitHub Actions repository secrets.`))
    .catch((err) => {
      console.error('Failed to set secret:', err);
      process.exit(1);
    });
}

