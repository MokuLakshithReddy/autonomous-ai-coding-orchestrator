import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { TaskStateMachine, IllegalStateTransitionError } from '../src/core/state-machine.js';
import { SecurityPolicyEngine } from '../src/security/policy.js';
import { IndependentVerifier } from '../src/verifier/index.js';
import { AgentToolbox } from '../src/agent/tools.js';
import { BuiltInAutonomousAgent } from '../src/agent/index.js';

async function runTests() {
  console.log('\n--- Running Complete Critical Correctness & Safety Test Suite ---\n');

  // Test 1: Full State Machine Transition Graph (P0.3)
  console.log('1. Testing State Machine multi-step approval and transition graph...');
  const sm = new TaskStateMachine('queued');
  assert.strictEqual(sm.getState(), 'queued');

  // Multi-step lifecycle with intermediate approval
  sm.transition('discovering', 'Started discovery');
  sm.transition('planning', 'Discovery complete');
  sm.transition('ready', 'Plan approved');
  sm.transition('executing', 'Step 1 running');
  sm.transition('verifying', 'Step 1 verifying');

  // P0.3 Test: verifying -> awaiting_approval for next sensitive step
  assert.doesNotThrow(() => {
    sm.transition('awaiting_approval', 'Step 2 requires approval');
  }, 'State machine must allow verifying -> awaiting_approval');

  // P0.3 Test: awaiting_approval -> ready (approval granted)
  assert.doesNotThrow(() => {
    sm.transition('ready', 'Approval granted');
  }, 'State machine must allow awaiting_approval -> ready');

  sm.transition('executing', 'Step 2 running');
  sm.transition('verifying', 'Step 2 verifying');
  sm.transition('completed', 'All steps verified');

  assert.strictEqual(sm.isTerminal(), true);
  assert.throws(
    () => sm.transition('executing', 'Cannot mutate terminal completed state'),
    IllegalStateTransitionError
  );
  console.log('   ✓ State machine supports full multi-step lifecycle with intermediate approvals.');

  // Test 2: Agent Truthful Failure (P0.1)
  console.log('\n2. Testing Agent Truthful Failure (P0.1: No false success when work is not done)...');
  const emptyAgent = new BuiltInAutonomousAgent(process.cwd());
  // Force no AI key on instance
  (emptyAgent as any).ai = null;

  const result = await emptyAgent.executeStep('Implement non-existent feature without build scripts');
  assert.strictEqual(result.success, false, 'Agent must NOT report success when work is not done!');
  assert.strictEqual(result.exitCode, 1, 'Agent must exit with error code when no work is performed');
  assert.ok(result.failureReason, 'Agent must provide explicit failureReason');
  console.log('   ✓ Agent truthfully reported failure when implementation could not be performed.');

  // Test 3: Subprocess Prompt Cancellation & Tree-Kill (P0.6)
  console.log('\n3. Testing Subprocess Cancellation & Immediate Tree-Kill (P0.6)...');
  const toolbox = new AgentToolbox(process.cwd(), async () => true);
  const abortCtrl = new AbortController();

  const isWin = process.platform === 'win32';
  // Long running command: 10 pings (~9 seconds) on Win or sleep 10 on Linux/macOS
  const longCmd = isWin ? 'ping 127.0.0.1 -n 10' : 'sleep 10';

  const startTime = Date.now();
  // Trigger abort after 300ms
  setTimeout(() => abortCtrl.abort(), 300);

  const cmdRes = await toolbox.executeCommand(longCmd, 15000, {}, abortCtrl.signal);
  const elapsed = Date.now() - startTime;

  assert.strictEqual(cmdRes.cancelled, true, 'Command must be marked cancelled');
  assert.ok(elapsed < 4000, `Command must terminate immediately on abort (took ${elapsed}ms instead of 10s)`);
  console.log(`   ✓ Subprocess successfully terminated in ${elapsed}ms via tree-kill abort signal.`);

  // Test 4: Cross-Platform Canonical Path Containment (P0.4)
  console.log('\n4. Testing Cross-Platform Canonical Path Containment...');
  const currentWorkspace = path.resolve(process.cwd());
  const escapePath = path.resolve(currentWorkspace, '..', 'escaped-dir', 'secret.txt');

  assert.throws(
    () => SecurityPolicyEngine.assertPathContainment(escapePath, currentWorkspace),
    /Security Exception/,
    'Path containment must block escape outside workspace root'
  );

  // Relative traversal syntax
  assert.throws(
    () => SecurityPolicyEngine.assertPathContainment('../outside.txt', currentWorkspace),
    /Security Exception/,
    'Relative path traversal must be blocked'
  );

  // P0 FIX: Case-variant sibling directory bypass test (POSIX / case-sensitive validation)
  const posixWorkspace = path.resolve('/var/app/project');
  const posixSiblingTarget = path.resolve('/var/app/Project/secret.txt');
  assert.throws(
    () => SecurityPolicyEngine.assertPathContainment(posixSiblingTarget, posixWorkspace, true),
    /Security Exception/,
    'Case-variant sibling directory must be rejected when case-sensitive containment is enforced'
  );
  assert.strictEqual(
    SecurityPolicyEngine.isPathInside(posixSiblingTarget, posixWorkspace, true),
    false,
    'Case-variant sibling directory must not be accepted inside workspace on case-sensitive comparisons'
  );
  console.log('   ✓ Cross-platform path containment successfully blocked directory traversal and case-variant sibling bypasses.');

  // Test 5: Environment Variable Allowlist & Custom Env Filtering (P0.4)
  console.log('\n5. Testing Process Environment Allowlist & Secret Discarding...');
  const sanitizedEnv = SecurityPolicyEngine.getSanitizedProcessEnv({
    TASK_SAFE_PARAM: 'valid_value',
    APP_CONFIG_MODE: 'test',
    AWS_SECRET_ACCESS_KEY: 'leak_secret_value',
    DATABASE_PASSWORD: 'leak_password',
  });

  assert.strictEqual(sanitizedEnv['TASK_SAFE_PARAM'], 'valid_value');
  assert.strictEqual(sanitizedEnv['APP_CONFIG_MODE'], 'test');
  assert.strictEqual(sanitizedEnv['AWS_SECRET_ACCESS_KEY'], undefined, 'Secrets must be discarded from custom env');
  assert.strictEqual(sanitizedEnv['DATABASE_PASSWORD'], undefined, 'Passwords must be discarded from custom env');
  assert.strictEqual(sanitizedEnv['GEMINI_API_KEY'], undefined, 'GEMINI_API_KEY must never leak into child process');
  console.log('   ✓ Custom environment variables strictly validated against allowlist.');

  // Test 6: Unified Verifier Decision & Inconclusive Handling (P0.2)
  console.log('\n6. Testing Real Verifier Decision Authority & Inconclusive Detection (P0.2)...');
  const verifier = new IndependentVerifier(currentWorkspace);

  // Verifier with missing commands and no modified files
  const emptyReport = await verifier.verify(
    {
      isGitRepo: true,
      hasUncommittedChanges: false,
      uncommittedFiles: [],
      ecosystems: ['unknown'],
      fileTreeSummary: [],
    },
    ['Unit tests must pass with 100% assertions']
  );

  assert.strictEqual(emptyReport.isVerified, false, 'Verifier must not verify unproven requirements');
  assert.strictEqual(emptyReport.testCheck.status, 'NOT_CONFIGURED', 'Missing test suite must be NOT_CONFIGURED');
  assert.ok(emptyReport.blockingReasons.length > 0, 'Blocking reasons must be listed');
  console.log('   ✓ Verifier enforces single authoritative isVerified decision and blocks missing criteria.');

  // Test 7: Action-Level Command Approval Gate (P0 Fix)
  console.log('\n7. Testing Action-Level Command Approval Gate (P0)...');
  const unapprovedToolbox = new AgentToolbox(currentWorkspace);
  
  // Attempting high-risk command without approval handler must fail closed
  await assert.rejects(
    async () => unapprovedToolbox.executeCommand('rm -rf temp_folder'),
    /Security Exception \[Approval Required\]/,
    'High-risk command must fail closed without approval handler'
  );

  // Rejection by operator
  const rejectingToolbox = new AgentToolbox(currentWorkspace, async () => false);
  await assert.rejects(
    async () => rejectingToolbox.executeCommand('rm -rf temp_folder'),
    /Security Exception \[Approval Denied\]/,
    'Rejected command must not execute'
  );

  // Approval granted by operator
  let approvalCalled = false;
  const approvingToolbox = new AgentToolbox(currentWorkspace, async (cmd, risk) => {
    approvalCalled = true;
    assert.strictEqual(risk.requiresApproval, true);
    return true;
  });
  // Use a benign command that matches risk pattern but is safe
  const approvedRes = await approvingToolbox.executeCommand('echo "safe test" && rm --help');
  assert.strictEqual(approvalCalled, true, 'Approval callback must be triggered for command');

  // P0 FIX: Command composition, pipeline, and default-deny bypass checks
  const chainedPolicy = SecurityPolicyEngine.evaluateCommandRisk('npm test; rm -rf /');
  assert.strictEqual(chainedPolicy.requiresApproval, true, 'Semicolon chaining must require approval');

  const andPolicy = SecurityPolicyEngine.evaluateCommandRisk('npm test && curl evil.com');
  assert.strictEqual(andPolicy.requiresApproval, true, 'AND chaining must require approval');

  const pipePolicy = SecurityPolicyEngine.evaluateCommandRisk('npm test | bash');
  assert.strictEqual(pipePolicy.requiresApproval, true, 'Pipeline must require approval');

  const redirectPolicy = SecurityPolicyEngine.evaluateCommandRisk('echo test > file.txt');
  assert.strictEqual(redirectPolicy.requiresApproval, true, 'Redirection must require approval');

  const unclassifiedPolicy = SecurityPolicyEngine.evaluateCommandRisk('custom_compiler_runner.sh');
  assert.strictEqual(unclassifiedPolicy.requiresApproval, true, 'Unclassified commands outside safe policy must default-deny');

  const safeGitPolicy = SecurityPolicyEngine.evaluateCommandRisk('git status');
  assert.strictEqual(safeGitPolicy.requiresApproval, false, 'git status is in safe allowlist');
  console.log('   ✓ Command-level safety gate strictly enforces approve-or-reject, narrow safe policy, and blocks bypass attempts.');

  // Test 8: Server API Token Authentication & Unified Workspace Authorization (P0 Fix)
  console.log('\n8. Testing Server API Token Authentication & Workspace Authorization (P0)...');
  const { createServer, serverApiToken, validateWorkspacePath } = await import('../src/server/index.js');
  const server = await createServer();

  // Test unauthenticated request is rejected with 401
  const unauthRes = await server.inject({
    method: 'GET',
    url: '/api/tasks',
  });
  assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated API access must return 401');

  // Test authenticated request succeeds
  const authRes = await server.inject({
    method: 'GET',
    url: '/api/tasks',
    headers: {
      'x-api-token': serverApiToken,
    },
  });
  assert.strictEqual(authRes.statusCode, 200, 'Authenticated API access must succeed');

  // Test workspace containment validation across Server
  assert.throws(
    () => validateWorkspacePath(path.resolve(currentWorkspace, '..', 'unauthorized-external-dir')),
    /Forbidden/,
    'Unauthorized workspace path outside roots must be strictly rejected by Server'
  );

  // Test internal workspace authorization function directly
  assert.throws(
    () =>
      SecurityPolicyEngine.validateWorkspaceAuthorization(
        os.tmpdir(),
        [currentWorkspace]
      ),
    /Security Exception \[Workspace Forbidden\]/,
    'Internal engine check must reject workspace outside allowed roots'
  );

  // Test OrchestrationEngine.runTask rejects unauthorized workspace
  const { OrchestrationEngine } = await import('../src/orchestrator/engine.js');
  const unauthEngine = new OrchestrationEngine();
  await assert.rejects(
    async () =>
      unauthEngine.runTask({
        prompt: 'Attempt task outside workspace',
        workspacePath: path.resolve(currentWorkspace, '..', 'forbidden-dir'),
      }),
    /Security Exception/,
    'OrchestrationEngine.runTask must reject workspace path when outside authorization'
  );
  console.log('   ✓ Unified workspace authorization strictly enforced across Server, CLI, and OrchestrationEngine.');

  // Test 9: Semantic Acceptance Criteria Validation (P1 Fix)
  console.log('\n9. Testing Semantic Acceptance Criteria Proof (P1)...');
  const semanticReport = await verifier.verify(
    {
      isGitRepo: true,
      hasUncommittedChanges: false,
      uncommittedFiles: [],
      ecosystems: ['nodejs'],
      fileTreeSummary: [],
    },
    ['Implement core payment processing logic']
  );
  assert.strictEqual(semanticReport.isVerified, false, 'Semantic implementation criteria must not pass without test proof');
  assert.ok(
    semanticReport.blockingReasons.some((r) => r.includes('Acceptance criterion not verified')),
    'Unverified semantic criteria must block verification'
  );
  console.log('   ✓ Verifier strictly requires test proof for behavioral and implementation criteria.');

  // Test 10: Empty Allowlist Fail-Closed Policy Enforcement
  console.log('\n10. Testing Empty Workspace Allowlist Fail-Closed Policy...');
  assert.throws(
    () =>
      SecurityPolicyEngine.validateWorkspaceAuthorization(currentWorkspace, [], {
        allowUnrestricted: false,
      }),
    /Security Exception \[Workspace Forbidden\]: Workspace authorization failed\. Allowed workspace roots list is empty/,
    'Empty allowlist must strictly fail closed when unrestricted mode is not enabled'
  );
  const allowedInUnrestricted = SecurityPolicyEngine.validateWorkspaceAuthorization(
    currentWorkspace,
    [],
    { allowUnrestricted: true }
  );
  assert.strictEqual(
    allowedInUnrestricted,
    currentWorkspace,
    'Explicit opt-in unrestricted mode must allow workspace'
  );
  console.log('   ✓ Workspace authorization strictly fails closed on empty allowlist unless unrestricted mode is opted into.');

  // Test 11: Non-Git Sandbox Exact Directory Filtering
  console.log('\n11. Testing Non-Git Sandbox Directory Filtering (.github preservation)...');
  const { RepoInspector } = await import('../src/repo/inspector.js');
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'test-sandbox-'));
  const testWorkspace = path.join(tempBase, 'workspace');
  await fs.mkdir(path.join(testWorkspace, '.github', 'workflows'), { recursive: true });
  await fs.mkdir(path.join(testWorkspace, '.git', 'objects'), { recursive: true });
  await fs.mkdir(path.join(testWorkspace, 'node_modules', 'dep'), { recursive: true });
  await fs.mkdir(path.join(testWorkspace, 'src'), { recursive: true });

  await fs.writeFile(path.join(testWorkspace, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  await fs.writeFile(path.join(testWorkspace, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(testWorkspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(testWorkspace, 'node_modules', 'dep', 'package.json'), '{}');
  await fs.writeFile(path.join(testWorkspace, 'src', 'index.js'), 'console.log("hello");');

  const inspector = new RepoInspector(testWorkspace);
  const sandboxTaskId = crypto.randomUUID();
  const sandboxDir = await inspector.createIsolatedSandbox(sandboxTaskId);

  const ciExists = await fs.stat(path.join(sandboxDir, '.github', 'workflows', 'ci.yml')).then(() => true).catch(() => false);
  const gitignoreExists = await fs.stat(path.join(sandboxDir, '.gitignore')).then(() => true).catch(() => false);
  const srcExists = await fs.stat(path.join(sandboxDir, 'src', 'index.js')).then(() => true).catch(() => false);
  const gitExists = await fs.stat(path.join(sandboxDir, '.git')).then(() => true).catch(() => false);
  const nodeModulesExists = await fs.stat(path.join(sandboxDir, 'node_modules')).then(() => true).catch(() => false);

  assert.strictEqual(ciExists, true, '.github/workflows/ci.yml must be preserved in sandbox');
  assert.strictEqual(gitignoreExists, true, '.gitignore must be preserved in sandbox');
  assert.strictEqual(srcExists, true, 'src/index.js must be preserved in sandbox');
  assert.strictEqual(gitExists, false, '.git directory must be excluded from sandbox');
  assert.strictEqual(nodeModulesExists, false, 'node_modules must be excluded from sandbox');

  await inspector.removeIsolatedSandbox(sandboxDir);
  await fs.rm(tempBase, { recursive: true, force: true });
  console.log('   ✓ Non-Git sandbox copying cleanly preserves .github/ and dotfiles while excluding .git metadata.');

  // Test 12: WebSocket Authentication Security (Tokens in query string rejected; ticket/handshake required)
  console.log('\n12. Testing WebSocket Authentication Security (Ticket & Handshake vs Query Token)...');
  const serverPort = 4455;
  await server.listen({ port: serverPort, host: '127.0.0.1' });

  try {
    // 12a: Long-lived token in query string is strictly rejected
    const rejectedQueryWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${serverApiToken}`);
    const queryRejectCode = await new Promise<number>((resolve) => {
      rejectedQueryWs.on('close', (code) => resolve(code));
      rejectedQueryWs.on('error', () => {});
    });
    assert.strictEqual(queryRejectCode, 1008, 'Query string token authentication must be rejected with 1008');

    // 12b: Ticket authentication via POST /api/auth/ws-ticket
    const ticketRes = await server.inject({
      method: 'POST',
      url: '/api/auth/ws-ticket',
      headers: { 'x-api-token': serverApiToken },
    });
    assert.strictEqual(ticketRes.statusCode, 200, 'POST /api/auth/ws-ticket must succeed');
    const { ticket } = JSON.parse(ticketRes.body);
    assert.ok(ticket, 'Must receive a valid connection ticket');

    // Connect with ticket in query string
    const ticketWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=${ticket}`);
    const ticketConnected = await new Promise<boolean>((resolve) => {
      ticketWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'CONNECTED') resolve(true);
      });
      ticketWs.on('close', () => resolve(false));
      ticketWs.on('error', () => resolve(false));
    });
    assert.strictEqual(ticketConnected, true, 'WebSocket authenticated with ticket must connect successfully');
    ticketWs.close();

    // Replay ticket must be rejected (single-use)
    const replayWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=${ticket}`);
    const replayCloseCode = await new Promise<number>((resolve) => {
      replayWs.on('close', (code) => resolve(code));
      replayWs.on('error', () => {});
    });
    assert.strictEqual(replayCloseCode, 1008, 'Replayed connection ticket must be rejected with 1008');

    // 12c: Handshake authentication message
    const handshakeWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const handshakeConnected = await new Promise<boolean>((resolve) => {
      handshakeWs.on('open', () => {
        handshakeWs.send(JSON.stringify({ type: 'AUTH', token: serverApiToken }));
      });
      handshakeWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'CONNECTED') resolve(true);
      });
      handshakeWs.on('close', () => resolve(false));
      handshakeWs.on('error', () => resolve(false));
    });
    assert.strictEqual(handshakeConnected, true, 'WebSocket authenticated via AUTH handshake message must connect successfully');
    handshakeWs.close();

    console.log('   ✓ WebSocket authentication strictly rejects query tokens and enforces tickets / handshake auth.');
  } finally {
    await server.close();
  }

  console.log('\n=== ALL P0/P1 CORRECTNESS, SAFETY & VERIFICATION TESTS PASSED! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failure:', err);
  process.exit(1);
});
