import assert from 'node:assert';
import { validateSecretName, setGitHubSecret } from '../scripts/set-secret.js';
import { AgentToolbox } from '../src/agent/tools.js';

async function runSetSecretTests() {
  console.log('\n--- Running Secret-Setting Tool Operational & Security Tests ---\n');

  // 1. Valid Secret Name Validation
  console.log('1. Testing Valid Secret Names...');
  assert.doesNotThrow(() => validateSecretName('GEMINI_API_KEY'));
  assert.doesNotThrow(() => validateSecretName('MY_SECRET_123'));
  assert.doesNotThrow(() => validateSecretName('_PRIVATE_KEY'));
  console.log('   ✓ Valid secret names accepted.');

  // 2. Invalid Secret Name Rejection
  console.log('\n2. Testing Invalid Secret Names (Path Traversal, Reserved Prefixes, Invalid Chars)...');
  assert.throws(
    () => validateSecretName('../../malicious_path'),
    /Invalid secret name/,
    'Path traversal characters must be rejected'
  );
  assert.throws(
    () => validateSecretName('123_STARTS_WITH_NUMBER'),
    /Invalid secret name/,
    'Names starting with numbers must be rejected'
  );
  assert.throws(
    () => validateSecretName('GITHUB_TOKEN_OVERWRITE'),
    /cannot start with "GITHUB_"/,
    'Reserved GITHUB_ prefix must be rejected'
  );
  assert.throws(
    () => validateSecretName('a'.repeat(101)),
    /exceeds GitHub maximum limit/,
    'Names exceeding 100 characters must be rejected'
  );
  assert.throws(
    () => validateSecretName(''),
    /non-empty string/,
    'Empty names must be rejected'
  );
  console.log('   ✓ Invalid secret names safely rejected before network transmission.');

  // 3. Empty Secret Value Rejection
  console.log('\n3. Testing Empty Secret Value Rejection...');
  await assert.rejects(
    async () => setGitHubSecret('VALID_NAME', '   ', 'dummy-token'),
    /Secret value cannot be empty/,
    'Blank/whitespace secret values must be rejected'
  );
  console.log('   ✓ Empty secret values rejected.');

  // 4. Authentication Failure (Missing / Invalid Token)
  console.log('\n4. Testing Authentication Token Failures (401 / Missing)...');
  await assert.rejects(
    async () => setGitHubSecret('GEMINI_API_KEY', 'valid_secret_value', ''),
    /Authentication required/,
    'Missing token must throw authentication error'
  );
  await assert.rejects(
    async () => setGitHubSecret('GEMINI_API_KEY', 'super_secret_payload_12345', 'invalid_fake_token_xyz'),
    (err: Error) => {
      // Confirm that the secret value is NEVER leaked in the error message!
      assert.strictEqual(
        err.message.includes('super_secret_payload_12345'),
        false,
        'Secret value must NEVER appear in thrown error message!'
      );
      return err.message.includes('401') || err.message.includes('GitHub API Error');
    },
    'Invalid token must return 401 error without leaking secret value'
  );
  console.log('   ✓ HTTP 401 Unauthorized handled cleanly without leaking secret payload.');

  // 5. CLI Process Arguments Hardening Test
  console.log('\n5. Testing CLI Argument Rejection (Process Inspection Prevention)...');
  const toolbox = new AgentToolbox(process.cwd(), async () => true);
  const cliRes = await toolbox.executeCommand(
    'node node_modules/tsx/dist/cli.mjs scripts/set-secret.ts LEAKED_KEY my_exposed_password',
    10000
  );
  assert.notStrictEqual(cliRes.exitCode, 0, 'CLI must reject secret in argv[3]');
  assert.ok(
    cliRes.stderr.includes('SECURITY ERROR') || cliRes.stderr.includes('Do not pass secret values'),
    'CLI must display security warning'
  );
  assert.strictEqual(
    cliRes.stdout.includes('my_exposed_password'),
    false,
    'Secret must not be echoed in stdout'
  );
  console.log('   ✓ CLI argument rejection verified.');

  console.log('\n=== ALL SECRET-SETTING OPERATIONAL & SECURITY TESTS PASSED! ===\n');
}

runSetSecretTests().catch((err) => {
  console.error('\n❌ Set-Secret Test Suite Failure:', err);
  process.exit(1);
});

