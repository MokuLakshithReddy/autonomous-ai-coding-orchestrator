import assert from 'node:assert';
import path from 'node:path';
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
  const toolbox = new AgentToolbox(process.cwd());
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
  console.log('   ✓ Cross-platform path containment successfully blocked directory traversal.');

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
  console.log('   ✓ Command-level safety gate strictly enforces approve-or-reject before execution.');

  // Test 8: Server API Token Authentication & Workspace Authorization (P0 Fix)
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

  // Test workspace containment validation
  assert.throws(
    () => validateWorkspacePath(path.resolve(currentWorkspace, '..', 'unauthorized-external-dir')),
    /Forbidden/,
    'Unauthorized workspace path outside roots must be strictly rejected'
  );
  console.log('   ✓ Server API strictly requires session token and blocks unauthorized workspace paths.');

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

  console.log('\n=== ALL P0/P1 CORRECTNESS, SAFETY & VERIFICATION TESTS PASSED! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failure:', err);
  process.exit(1);
});
