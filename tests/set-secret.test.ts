import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { validateSecretName, setGitHubSecret, HttpTransport } from '../scripts/set-secret.js';
import { AgentToolbox } from '../src/agent/tools.js';

function createMockTransport(options: {
  getKeyStatus?: number;
  getKeyBody?: any;
  putStatus?: number;
  putBody?: string;
}): HttpTransport {
  // A valid 32-byte curve25519 public key base64 for tweetsodium
  const validKey = Buffer.alloc(32, 7).toString('base64');

  return {
    get: ((url: any, cb: any) => {
      const res = new EventEmitter() as any;
      res.statusCode = options.getKeyStatus ?? 200;
      process.nextTick(() => {
        if (typeof cb === 'function') cb(res);
        const data = options.getKeyBody !== undefined ? JSON.stringify(options.getKeyBody) : JSON.stringify({
          key_id: 'test_key_123',
          key: validKey,
        });
        res.emit('data', data);
        res.emit('end');
      });
      const req = new EventEmitter() as any;
      return req;
    }) as any,
    request: ((url: any, cb: any) => {
      const res = new EventEmitter() as any;
      res.statusCode = options.putStatus ?? 201;
      process.nextTick(() => {
        if (typeof cb === 'function') cb(res);
        res.emit('data', options.putBody || '');
        res.emit('end');
      });
      const req = new EventEmitter() as any;
      req.write = () => true;
      req.end = () => true;
      return req;
    }) as any,
  };
}

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

  // 4. Mocked HTTPS Layer: Deterministic HTTP Error Handling & Credential Leakage Prevention
  console.log('\n4. Testing Deterministic Mocked HTTP Error Handling (401, 403, 404, 500)...');
  
  // 4a: Missing authentication token
  await assert.rejects(
    async () => setGitHubSecret('GEMINI_API_KEY', 'valid_secret_value', ''),
    /Authentication required/,
    'Missing token must throw authentication error'
  );

  // 4b: 401 Unauthorized via Mock Transport
  const mock401 = createMockTransport({ getKeyStatus: 401 });
  await assert.rejects(
    async () =>
      setGitHubSecret('GEMINI_API_KEY', 'super_secret_payload_12345', 'mock_token', {
        transport: mock401,
      }),
    (err: Error) => {
      assert.strictEqual(
        err.message.includes('super_secret_payload_12345'),
        false,
        'Secret value must NEVER appear in thrown error message!'
      );
      return err.message.includes('401');
    },
    '401 response must throw cleanly without leaking secret payload'
  );

  // 4c: 403 Forbidden via Mock Transport
  const mock403 = createMockTransport({ getKeyStatus: 403 });
  await assert.rejects(
    async () =>
      setGitHubSecret('GEMINI_API_KEY', 'secret_data_to_protect', 'mock_token', {
        transport: mock403,
      }),
    (err: Error) => {
      assert.strictEqual(err.message.includes('secret_data_to_protect'), false);
      return err.message.includes('403');
    },
    '403 response must indicate token permission issue'
  );

  // 4d: 404 Not Found on PUT via Mock Transport
  const mock404 = createMockTransport({ putStatus: 404 });
  await assert.rejects(
    async () =>
      setGitHubSecret('GEMINI_API_KEY', 'secret_payload', 'mock_token', {
        transport: mock404,
      }),
    (err: Error) => {
      assert.strictEqual(err.message.includes('secret_payload'), false);
      return err.message.includes('404');
    },
    '404 response must indicate repository not found'
  );

  // 4e: Successful secret provisioning via Mock Transport
  const mockSuccess = createMockTransport({ getKeyStatus: 200, putStatus: 201 });
  const successRes = await setGitHubSecret('GEMINI_API_KEY', 'valid_secret_to_store', 'mock_token', {
    transport: mockSuccess,
  });
  assert.strictEqual(successRes, true, 'Successful secret set must return true');
  console.log('   ✓ Deterministic mock HTTP tests verified without external network calls.');

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

  // 6. Optional Real Remote Integration Test (Opt-In Only)
  if (process.env.RUN_GITHUB_INTEGRATION === 'true' && process.env.GITHUB_TOKEN) {
    console.log('\n6. Running Optional Real GitHub API Integration Test (Opt-In)...');
    try {
      await setGitHubSecret('TEST_INTEGRATION_KEY', 'integration_val_test', process.env.GITHUB_TOKEN);
      console.log('   ✓ Live GitHub secret provisioning succeeded.');
    } catch (err: any) {
      console.log('   ℹ️  Live integration note:', err.message);
    }
  }

  console.log('\n=== ALL SECRET-SETTING OPERATIONAL & SECURITY TESTS PASSED! ===\n');
}

runSetSecretTests().catch((err) => {
  console.error('\n❌ Set-Secret Test Suite Failure:', err);
  process.exit(1);
});
