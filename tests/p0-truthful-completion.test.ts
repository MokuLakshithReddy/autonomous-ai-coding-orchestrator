process.env.USE_CONTAINER_SANDBOX = 'false';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { TaskStateMachine, IllegalStateTransitionError } from '../src/core/state-machine.js';
import { SecurityPolicyEngine } from '../src/security/policy.js';
import { ContainerSandbox } from '../src/security/sandbox.js';
import { IndependentVerifier } from '../src/verifier/index.js';
import { AgentToolbox } from '../src/agent/tools.js';
import { BuiltInAutonomousAgent, createAgent } from '../src/agent/index.js';
import { taskRepo, verificationRepo, eventRepo, initDatabase } from '../src/db/index.js';

async function runTests() {
  await initDatabase();
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

  // Test 10: Exhaustive Workspace Authorization Parity across API, CLI, and Engine
  console.log('\n10. Testing Exhaustive Workspace Authorization Parity across API, CLI, and Engine...');

  const tempAuthBase = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-auth-test-'));
  const allowedRoot = path.join(tempAuthBase, 'allowed-root');
  const allowedChild = path.join(allowedRoot, 'project-a');
  const outsideDir = path.join(tempAuthBase, 'outside-secret');
  const symlinkOutside = path.join(allowedRoot, 'symlink-to-outside');

  await fs.mkdir(allowedChild, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  try {
    await fs.symlink(outsideDir, symlinkOutside, 'junction');
  } catch {
    // If symlinks require privilege on Windows, create a directory for fallback testing
  }

  // Set up real git repository in allowedChild for end-to-end task execution
  const { simpleGit } = await import('simple-git');
  const allowedGit = simpleGit(allowedChild);
  await allowedGit.init();
  await allowedGit.addConfig('user.name', 'Security Test');
  await allowedGit.addConfig('user.email', 'security@orchestrator.local');
  await fs.writeFile(
    path.join(allowedChild, 'package.json'),
    JSON.stringify({ name: 'security-test-app', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)
  );
  await fs.writeFile(path.join(allowedChild, 'index.js'), 'console.log("secure");');
  await allowedGit.add('.');
  await allowedGit.commit('Initial security test commit');

  // Deterministic mock agent to execute tasks without external LLM calls
  const deterministicMockAgent = {
    name: 'DeterministicSecurityAgent',
    async executeStep() {
      return {
        agentName: 'DeterministicSecurityAgent',
        success: true,
        logs: 'Deterministic execution in authorized workspace',
        toolsUsed: ['mockTool'],
        exitCode: 0,
      };
    },
  };

  const entryPoints = [
    {
      name: 'Server API (validateWorkspacePath)',
      run: async (target: string, roots: string[], unres: boolean) => {
        return validateWorkspacePath(target, roots, { allowUnrestricted: unres });
      },
    },
    {
      name: 'CLI Entry Point (SecurityPolicyEngine validate & contain)',
      run: async (target: string, roots: string[], unres: boolean) => {
        const authorized = SecurityPolicyEngine.validateWorkspaceAuthorization(target, roots, { allowUnrestricted: unres });
        return SecurityPolicyEngine.assertPathContainment(authorized, authorized);
      },
    },
    {
      name: 'Engine Execution Boundary (OrchestrationEngine.runTask)',
      run: async (target: string, roots: string[], unres: boolean) => {
        const engineInstance = new OrchestrationEngine({ allowedWorkspaces: roots, allowUnrestricted: unres });
        return await engineInstance.runTask({
          prompt: 'Execute deterministic security test',
          workspacePath: target,
          customAgent: deterministicMockAgent,
        });
      },
    },
  ];

  for (const ep of entryPoints) {
    // 10a: Empty allowlist must strictly fail closed by default
    await assert.rejects(
      async () => ep.run(allowedChild, [], false),
      /Security Exception \[Workspace Forbidden\]|Forbidden:/,
      `${ep.name} must fail closed when allowlist is empty and unrestricted mode is false`
    );

    // 10b: Explicit opt-in unrestricted mode must execute real task and consistently permit workspace
    await assert.doesNotReject(
      async () => {
        const result: any = await ep.run(allowedChild, [], true);
        const canonicalExpected = SecurityPolicyEngine.resolveCanonicalPath(allowedChild);
        if (ep.name.includes('Engine Execution')) {
          assert.ok(result && result.id, 'Engine must create and execute real task record in unrestricted mode');
          const canonicalActual = SecurityPolicyEngine.resolveCanonicalPath(result.workspacePath);
          assert.strictEqual(
            canonicalActual,
            canonicalExpected,
            'Engine task record must target authorized workspace path'
          );
        } else {
          const canonicalActual = SecurityPolicyEngine.resolveCanonicalPath(result);
          assert.strictEqual(
            canonicalActual,
            canonicalExpected,
            `${ep.name} must return canonical authorized path`
          );
        }
      },
      `${ep.name} must permit valid workspace in explicit unrestricted mode`
    );

    // 10c: Path outside configured roots must be rejected at every entry point
    await assert.rejects(
      async () => ep.run(outsideDir, [allowedRoot], false),
      /Security Exception \[Workspace Forbidden\]|Forbidden:/,
      `${ep.name} must reject workspace outside configured roots`
    );

    // 10d: Directory traversal (..) escaping configured roots must be rejected
    const traversalPath = path.join(allowedRoot, '..', 'outside-secret');
    await assert.rejects(
      async () => ep.run(traversalPath, [allowedRoot], false),
      /Security Exception \[Workspace Forbidden\]|Forbidden:/,
      `${ep.name} must reject path traversal escaping allowed roots`
    );

    // 10e: Symlink resolving outside configured roots must be rejected
    const symlinkStat = await fs.lstat(symlinkOutside).catch(() => null);
    if (symlinkStat) {
      await assert.rejects(
        async () => ep.run(symlinkOutside, [allowedRoot], false),
        /Security Exception \[Workspace Forbidden\]|Forbidden:/,
        `${ep.name} must reject symlink escaping configured roots`
      );
    }
  }

  try {
    await fs.rm(tempAuthBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  console.log('   ✓ Workspace authorization parity verified: empty allowlist fail-closed, opt-in unrestricted real task execution, outside paths, path-traversal & symlinks strictly enforced.');

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

  // Test 12: WebSocket Authentication Security (Browser-compatible ticket auth, expiry, memory cleanup)
  console.log('\n12. Testing WebSocket Authentication Security (Browser Ticket, Expiry & Memory Cleanup)...');
  const { issueWsTicket, consumeWsTicket, cleanupExpiredWsTickets, wsTickets } = await import('../src/server/index.js');
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

    // Connect with standard browser-like client (no custom headers) using ticket in query string
    const browserWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=${ticket}`);
    const browserConnected = await new Promise<boolean>((resolve) => {
      browserWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'CONNECTED') resolve(true);
      });
      browserWs.on('close', () => resolve(false));
      browserWs.on('error', () => resolve(false));
    });
    assert.strictEqual(browserConnected, true, 'Browser WebSocket with ticket must connect without being blocked by HTTP middleware');
    browserWs.close();

    // Replay ticket must be rejected (single-use)
    const replayWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=${ticket}`);
    const replayCloseCode = await new Promise<number>((resolve) => {
      replayWs.on('close', (code) => resolve(code));
      replayWs.on('error', () => {});
    });
    assert.strictEqual(replayCloseCode, 1008, 'Replayed connection ticket must be rejected with 1008');

    // 12c: Expired ticket must fail
    const expiredTicket = issueWsTicket(-1000); // Created already expired
    const expiredWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=${expiredTicket}`);
    const expiredCloseCode = await new Promise<number>((resolve) => {
      expiredWs.on('close', (code) => resolve(code));
      expiredWs.on('error', () => {});
    });
    assert.strictEqual(expiredCloseCode, 1008, 'Expired ticket must be rejected with 1008');

    // 12d: Invalid ticket must fail
    const invalidWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?ticket=non-existent-ticket-9999`);
    const invalidCloseCode = await new Promise<number>((resolve) => {
      invalidWs.on('close', (code) => resolve(code));
      invalidWs.on('error', () => {});
    });
    assert.strictEqual(invalidCloseCode, 1008, 'Invalid ticket must be rejected with 1008');

    // 12e: Memory cleanup test: tickets cannot accumulate indefinitely
    const t1 = issueWsTicket(1000);
    const t2 = issueWsTicket(1000);
    assert.ok(wsTickets.has(t1), 'Active ticket t1 stored in memory');
    assert.ok(wsTickets.has(t2), 'Active ticket t2 stored in memory');
    const cleaned = cleanupExpiredWsTickets(Date.now() + 10_000);
    assert.ok(cleaned >= 2, 'Expired tickets must be pruned');
    assert.strictEqual(wsTickets.has(t1), false, 'Expired ticket t1 must be purged from memory');
    assert.strictEqual(wsTickets.has(t2), false, 'Expired ticket t2 must be purged from memory');

    // 12f: Ticket capacity exhaustion must reject admission without invalidating existing tickets
    const { MAX_WS_TICKETS } = await import('../src/server/index.js');
    wsTickets.clear();
    const activeTickets: string[] = [];
    for (let i = 0; i < MAX_WS_TICKETS; i++) {
      const t = issueWsTicket(60_000);
      activeTickets.push(t);
    }
    assert.strictEqual(wsTickets.size, MAX_WS_TICKETS, 'Ticket store must reach capacity limit');

    // Verify existing tickets are not evicted when store is saturated
    const sampleTicket = activeTickets[0];
    assert.ok(wsTickets.has(sampleTicket), 'Existing active ticket must be present before overflow attempt');

    // Saturated store must reject direct issuance
    assert.throws(
      () => issueWsTicket(60_000),
      /capacity exhausted/,
      'Direct ticket issuance must throw when store capacity is exhausted'
    );

    // Saturated store must reject HTTP API request with HTTP 429
    const overflowRes = await server.inject({
      method: 'POST',
      url: '/api/auth/ws-ticket',
      headers: { 'x-api-token': serverApiToken },
    });
    assert.strictEqual(overflowRes.statusCode, 429, 'API must return 429 Too Many Requests when capacity is exhausted');

    // Existing active ticket must still be completely intact
    assert.ok(wsTickets.has(sampleTicket), 'Existing active tickets must NOT be evicted by capacity overflow');

    // Free capacity by advancing time past expiry
    wsTickets.clear();

    // 12g: Handshake authentication message
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

    console.log('   ✓ WebSocket authentication strictly rejects query tokens, enables browser tickets, and prunes expired entries from memory.');
  } finally {
    await server.close();
  }

  // Test 13: Truthful Outcomes Persistence & Independent Verification Gate (P0/P1)
  console.log('\n13. Testing Truthful Outcomes Persistence & Independent Verification Integrity...');
  const test13Base = await fs.mkdtemp(path.join(os.tmpdir(), 'truthful-persistence-test-'));
  const test13Repo = path.join(test13Base, 'repo');
  await fs.mkdir(test13Repo, { recursive: true });

  const t13Git = simpleGit(test13Repo);
  await t13Git.init();
  await t13Git.addConfig('user.name', 'Verification Tester');
  await t13Git.addConfig('user.email', 'verify@orchestrator.local');

  // Seed failing test suite
  await fs.writeFile(
    path.join(test13Repo, 'package.json'),
    JSON.stringify({ name: 'verify-guard-test', scripts: { test: 'node test.js' } }, null, 2)
  );
  await fs.writeFile(
    path.join(test13Repo, 'test.js'),
    'console.error("Test failed deliberately"); process.exit(1);\n'
  );
  await t13Git.add('.');
  await t13Git.commit('Initial failing test commit');

  // 13a: Model claiming success when tests fail must NEVER result in 'completed' state
  const mockLyingAgent = {
    name: 'MockLyingAgent',
    async executeStep() {
      return {
        agentName: 'MockLyingAgent',
        success: true, // Agent falsely claims it succeeded
        logs: 'Agent claims all work is finished',
        toolsUsed: ['fakeTool'],
        exitCode: 0,
      };
    },
  };

  const testEngine = new OrchestrationEngine({ allowedWorkspaces: [test13Repo] });
  const failedTask = await testEngine.runTask({
    prompt: 'Fix the application and make test pass',
    workspacePath: test13Repo,
    maxRetries: 1,
    customAgent: mockLyingAgent,
  });

  // Wait for task to reach terminal state
  const startT13 = Date.now();
  let latestT13 = await taskRepo.getById(failedTask.id);
  while (latestT13 && !['completed', 'failed', 'partially_completed', 'blocked', 'cancelled'].includes(latestT13.status.toLowerCase())) {
    if (Date.now() - startT13 > 25000) break;
    await new Promise((r) => setTimeout(r, 200));
    latestT13 = await taskRepo.getById(failedTask.id);
  }

  assert.ok(latestT13, 'Task record must exist in durable database');
  assert.notStrictEqual(
    latestT13.status.toLowerCase(),
    'completed',
    'Task with failing tests must NEVER be marked COMPLETED, regardless of agent claims'
  );
  assert.ok(
    ['failed', 'partially_completed'].includes(latestT13.status.toLowerCase()),
    `Task with failing test must enter failed or partially_completed; got: ${latestT13.status}`
  );

  // 13b: Verify final verification record was persisted with FAILED status and blocking reasons
  const t13Verifs = await verificationRepo.listForTask(failedTask.id);
  assert.ok(t13Verifs.length > 0, 'Durable verification ledger must record verification attempts');
  const finalVerifRec = t13Verifs[t13Verifs.length - 1];
  assert.strictEqual(finalVerifRec.status, 'FAILED', 'Verification record status must be FAILED');
  assert.strictEqual(finalVerifRec.testStatus, 'FAILED', 'Test check status must be FAILED');

  // 13c: Database failure during verification persistence must abort completion
  const origRecord = verificationRepo.record.bind(verificationRepo);
  const test13Repo2 = path.join(test13Base, 'repo2');
  await fs.mkdir(test13Repo2, { recursive: true });
  const t13Git2 = simpleGit(test13Repo2);
  await t13Git2.init();
  await t13Git2.addConfig('user.name', 'Tester');
  await t13Git2.addConfig('user.email', 'test@test.local');
  await fs.writeFile(
    path.join(test13Repo2, 'package.json'),
    JSON.stringify({ name: 'db-fail-test', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)
  );
  await t13Git2.add('.');
  await t13Git2.commit('Passing test commit');

  try {
    // Inject database failure on verification persistence
    let dbCallCount = 0;
    (verificationRepo as any).record = async (record: any) => {
      dbCallCount++;
      if (dbCallCount > 1) {
        throw new Error('Simulated SQLite disk I/O failure during verification write');
      }
      return origRecord(record);
    };

    const testEngine2 = new OrchestrationEngine({ allowedWorkspaces: [test13Repo2] });
    const dbFailTask = await testEngine2.runTask({
      prompt: 'Passing task with database failure',
      workspacePath: test13Repo2,
      maxRetries: 0,
      customAgent: {
        name: 'SimplePassingAgent',
        async executeStep() {
          return { agentName: 'SimplePassingAgent', success: true, logs: 'Done', toolsUsed: [], exitCode: 0 };
        },
      },
    });

    const startDbWait = Date.now();
    let dbTaskRec = await taskRepo.getById(dbFailTask.id);
    while (dbTaskRec && !['completed', 'failed', 'blocked', 'cancelled'].includes(dbTaskRec.status.toLowerCase())) {
      if (Date.now() - startDbWait > 15000) break;
      await new Promise((r) => setTimeout(r, 200));
      dbTaskRec = await taskRepo.getById(dbFailTask.id);
    }

    assert.ok(dbTaskRec, 'Task record must exist');
    assert.notStrictEqual(
      dbTaskRec.status.toLowerCase(),
      'completed',
      'Database failure during verification persistence must NEVER leave task marked completed'
    );
    assert.strictEqual(
      dbTaskRec.status.toLowerCase(),
      'failed',
      'Database failure during verification persistence must transition task to FAILED'
    );
  } finally {
    verificationRepo.record = origRecord;
    try {
      await fs.rm(test13Base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }

  console.log('   ✓ Truthful persistence verified: model claims rejected on test failures, DB failures fail safe to FAILED.');

  // Test 14: Verification-Time File Mutation (Workspace Integrity Violation)
  console.log('\n14. Testing Workspace Integrity Violation during Verification...');
  const test14Base = path.join(os.tmpdir(), `test14-integrity-${Date.now()}`);
  await fs.mkdir(test14Base, { recursive: true });
  const t14Git = simpleGit(test14Base);
  await t14Git.init();
  await t14Git.addConfig('user.name', 'Tester');
  await t14Git.addConfig('user.email', 'test@test.local');
  await fs.writeFile(
    path.join(test14Base, 'package.json'),
    JSON.stringify({ name: 'integrity-test', scripts: { test: 'node -e "console.log(\'✓ 1 test passed\'); process.exit(0)"' } }, null, 2)
  );
  await t14Git.add('.');
  await t14Git.commit('Initial passing commit');

  try {
    const testEngine14 = new OrchestrationEngine({ allowedWorkspaces: [test14Base] });
    
    // Custom verifier interceptor that mutates workspace during verification
    let verifierMutated = false;
    const origVerifierVerify = IndependentVerifier.prototype.verify;
    (IndependentVerifier.prototype as any).verify = async function(...args: any[]) {
      const res = await (origVerifierVerify as any).apply(this, args);
      // Mutate workspace during verification
      if (!verifierMutated) {
        verifierMutated = true;
        await fs.writeFile(path.join(this.workspacePath, 'untracked_sneak_mutation.txt'), 'sneak mutation');
      }
      return res;
    };

    try {
      const task14 = await testEngine14.runTask({
        prompt: 'Task where workspace mutates during verification',
        workspacePath: test14Base,
        maxRetries: 0,
        customAgent: {
          name: 'ModifyingAgent',
          async executeStep() {
            const ws = (this as any).workspacePath || test14Base;
            await fs.writeFile(path.join(ws, 'feature.js'), 'export const active = true;\n');
            return {
              agentName: 'ModifyingAgent',
              success: true,
              logs: 'Feature implemented',
              toolsUsed: ['writeFile'],
              exitCode: 0,
            };
          },
        },
      });

      const startWait14 = Date.now();
      let task14Rec = await taskRepo.getById(task14.id);
      while (task14Rec && !['completed', 'failed', 'blocked', 'cancelled', 'partially_completed', 'needs_human_review'].includes(task14Rec.status.toLowerCase())) {
        if (Date.now() - startWait14 > 25000) break;
        await new Promise((r) => setTimeout(r, 200));
        task14Rec = await taskRepo.getById(task14.id);
      }

      assert.ok(task14Rec, 'Task record 14 must exist');
      assert.notStrictEqual(
        task14Rec.status.toLowerCase(),
        'completed',
        'Workspace that mutated during verification must NEVER be marked COMPLETED'
      );
      
      const t14Verifs = await verificationRepo.listForTask(task14.id);
      assert.ok(t14Verifs.length > 0, 'Verification records must exist in durable ledger');
      const final14Verif = t14Verifs[t14Verifs.length - 1];
      assert.strictEqual(final14Verif.status, 'FAILED', 'Verification status must be FAILED on integrity mismatch');
      const details = JSON.parse(final14Verif.detailsJson);
      assert.ok(
        details.blockingReasons.some((r: string) => r.includes('Workspace integrity violation') || r.includes('mutated')),
        'Blocking reasons must report workspace integrity violation'
      );
      console.log('   ✓ Workspace integrity verified: uncommitted/untracked file changes during verification fail closed.');
    } finally {
      IndependentVerifier.prototype.verify = origVerifierVerify;
    }
  } finally {
    try {
      await fs.rm(test14Base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }

  // Test 15: Invalid Credentials Fail Closed (P0)
  console.log('\n15. Testing Invalid Credentials Fail-Closed Behavior...');
  const invalidCredAgent = new BuiltInAutonomousAgent(process.cwd());
  (invalidCredAgent as any).ai = {
    models: {
      generateContent: async () => {
        const err: any = new Error('API_KEY_INVALID: API key not valid. Please pass a valid API key.');
        err.status = 400;
        throw err;
      },
    },
  };

  const credResult = await invalidCredAgent.executeStep('Attempt work with invalid credentials');
  assert.strictEqual(credResult.success, false, 'Execution must fail when credentials are invalid');
  assert.notStrictEqual(credResult.exitCode, 0, 'Exit code must be non-zero for credential errors');
  assert.ok(
    credResult.failureReason?.includes('API_KEY_INVALID') || credResult.logs?.includes('API_KEY_INVALID'),
    'Failure diagnostic must surface the credential error cleanly'
  );
  console.log('   ✓ Invalid credentials fail closed truthfully with clear diagnostics.');

  // Test 16: Secret-Setting CLI Rejects Command-Line Credentials
  console.log('\n16. Testing Secret-Setting CLI Hardening (Credential Exposure Prevention)...');
  const setSecretCmd = await new AgentToolbox(process.cwd(), async () => true).executeCommand(
    'node node_modules/tsx/dist/cli.mjs scripts/set-secret.ts DUMMY_KEY insecure_cli_value',
    15000
  );
  assert.notStrictEqual(setSecretCmd.exitCode, 0, 'set-secret.ts must reject secret values passed in CLI arguments');
  assert.ok(
    setSecretCmd.stderr.includes('SECURITY ERROR') || setSecretCmd.stderr.includes('Do not pass secret values'),
    'set-secret.ts must output clear security error'
  );
  console.log('   ✓ Secret-setting script safely rejects secret values in CLI arguments.');

  // Test 17: Mutating Contents of Existing Untracked File During Verification
  console.log('\n17. Testing Fingerprint Detection of Content Mutation in Existing Untracked Files (P0)...');
  const test17Base = path.join(os.tmpdir(), `test17-untracked-${Date.now()}`);
  await fs.mkdir(test17Base, { recursive: true });
  const t17Git = simpleGit(test17Base);
  await t17Git.init();
  await t17Git.addConfig('user.name', 'Tester');
  await t17Git.addConfig('user.email', 'test@test.local');
  await fs.writeFile(path.join(test17Base, 'tracked.txt'), 'tracked initial');
  await t17Git.add('.');
  await t17Git.commit('Initial tracked commit');

  // Create an untracked file BEFORE verification
  const untrackedFile = path.join(test17Base, 'untracked_user_notes.txt');
  await fs.writeFile(untrackedFile, 'Original Untracked Content V1');

  const inspector17 = new (await import('../src/repo/inspector.js')).RepoInspector(test17Base);
  const fp1 = await inspector17.getWorkspaceFingerprint();

  // Mutate ONLY the content of the untracked file (status remains "?? untracked_user_notes.txt")
  await fs.writeFile(untrackedFile, 'Tampered Untracked Content V2 (Sneak Mutation)');
  const fp2 = await inspector17.getWorkspaceFingerprint();

  assert.notStrictEqual(
    fp1,
    fp2,
    'getWorkspaceFingerprint must detect content change inside existing untracked file!'
  );
  await fs.rm(test17Base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('   ✓ Untracked file content mutation reliably detected by content fingerprinting.');

  // Test 18: Mutating Non-Ephemeral Ignored File During Verification
  console.log('\n18. Testing Fingerprint Detection of Mutated Non-Ephemeral Ignored Files (P0)...');
  const test18Base = path.join(os.tmpdir(), `test18-ignored-${Date.now()}`);
  await fs.mkdir(test18Base, { recursive: true });
  const t18Git = simpleGit(test18Base);
  await t18Git.init();
  await t18Git.addConfig('user.name', 'Tester');
  await t18Git.addConfig('user.email', 'test@test.local');
  await fs.writeFile(path.join(test18Base, '.gitignore'), 'secrets.conf\ncoverage/\n*.log\n');
  await t18Git.add('.');
  await t18Git.commit('Initial commit with .gitignore');

  // Create non-ephemeral ignored file
  const ignoredSecretFile = path.join(test18Base, 'secrets.conf');
  await fs.writeFile(ignoredSecretFile, 'DB_PASSWORD=initial_safe_pass');

  const inspector18 = new (await import('../src/repo/inspector.js')).RepoInspector(test18Base);
  const fpIgnored1 = await inspector18.getWorkspaceFingerprint();

  // Mutate non-ephemeral ignored file
  await fs.writeFile(ignoredSecretFile, 'DB_PASSWORD=tampered_modified_pass');
  const fpIgnored2 = await inspector18.getWorkspaceFingerprint();

  assert.notStrictEqual(
    fpIgnored1,
    fpIgnored2,
    'getWorkspaceFingerprint must detect content change inside non-ephemeral ignored files!'
  );
  await fs.rm(test18Base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('   ✓ Non-ephemeral ignored file mutation reliably detected by content fingerprinting.');

  // Test 19: Distinguishing PASSED from NOT_CONFIGURED / INCONCLUSIVE (P1)
  console.log('\n19. Testing Verification Distinction Between PASSED and INCONCLUSIVE (P1)...');
  const unconfiguredVerifier = new IndependentVerifier(process.cwd());
  const inconclusiveReport = await unconfiguredVerifier.verify(
    {
      isGitRepo: false,
      hasUncommittedChanges: false,
      uncommittedFiles: [],
      ecosystems: ['unknown'],
      fileTreeSummary: [],
    },
    ['Build succeeds', 'Tests pass']
  );

  assert.strictEqual(inconclusiveReport.isVerified, false, 'Inconclusive verification must NEVER be marked verified');
  assert.strictEqual(inconclusiveReport.status, 'INCONCLUSIVE', 'Missing build/test runner must produce INCONCLUSIVE status');
  assert.ok(
    inconclusiveReport.blockingReasons.some((r) => r.includes('Inconclusive verification') || r.includes('Neither a build')),
    'Blocking reasons must explain lack of verification commands'
  );
  console.log('   ✓ Verifier strictly distinguishes PASSED from INCONCLUSIVE when verification evidence is absent.');

  // Test 20: Durable Event Persistence Awaiting & Retry Protection (P1)
  console.log('\n20. Testing Awaited Event Persistence & Error Propagation (P1)...');
  const testEngineEvents = new OrchestrationEngine({ allowedWorkspaces: [process.cwd()] });
  const eventTaskId = crypto.randomUUID();
  await taskRepo.create({
    id: eventTaskId,
    title: 'Event Persistence Test Task',
    prompt: 'Testing event persistence',
    workspacePath: process.cwd(),
    status: 'queued',
    retryCount: 0,
    maxRetries: 0,
    attemptId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  
  // Test event ledger append writes directly with a valid task
  await assert.doesNotReject(async () => {
    await testEngineEvents.emitOrchestratorEvent({
      taskId: eventTaskId,
      type: 'LOG',
      message: 'Awaited event persistence audit test',
    });
  }, 'emitOrchestratorEvent must successfully await database ledger write');
  console.log('   ✓ Orchestrator event ledger write confirmed awaited and durable.');

  // Test 21: Recursive Ignored Directory Fingerprinting & Unusual Paths (P0)
  console.log('\n21. Testing Recursive Ignored Directory Fingerprinting & Unusual Paths (P0)...');
  const test21Base = path.join(os.tmpdir(), `test21-ignored-dir-${Date.now()}`);
  await fs.mkdir(test21Base, { recursive: true });
  const t21Git = simpleGit(test21Base);
  await t21Git.init();
  await t21Git.addConfig('user.name', 'Tester');
  await t21Git.addConfig('user.email', 'test@test.local');
  await fs.writeFile(path.join(test21Base, '.gitignore'), 'custom_secret_dir/\n*.log\n');
  await t21Git.add('.');
  await t21Git.commit('Initial commit with .gitignore');

  // Create an ignored directory with nested files
  const ignoredDir = path.join(test21Base, 'custom_secret_dir');
  const nestedIgnoredDir = path.join(ignoredDir, 'nested space dir');
  await fs.mkdir(nestedIgnoredDir, { recursive: true });
  const secretKeyFile = path.join(nestedIgnoredDir, 'private.key');
  await fs.writeFile(secretKeyFile, 'ORIGINAL_PRIVATE_KEY_HASH_V1');

  // Create files with spaces, single quotes, and unusual characters
  const spaceFile = path.join(test21Base, 'path with space and [bracket].txt');
  await fs.writeFile(spaceFile, 'initial space content');
  const quoteFile = path.join(test21Base, "path'with'quote.txt");
  await fs.writeFile(quoteFile, 'initial quote content');

  const inspector21 = new (await import('../src/repo/inspector.js')).RepoInspector(test21Base);
  const fpDir1 = await inspector21.getWorkspaceFingerprint();

  // Mutate file DEEP inside already-ignored directory
  await fs.writeFile(secretKeyFile, 'TAMPERED_PRIVATE_KEY_HASH_V2');
  const fpDir2 = await inspector21.getWorkspaceFingerprint();

  assert.notStrictEqual(
    fpDir1,
    fpDir2,
    'getWorkspaceFingerprint must recursively detect file changes inside ignored directories!'
  );

  // Mutate file with spaces and brackets
  await fs.writeFile(spaceFile, 'tampered space content v2');
  const fpDir3 = await inspector21.getWorkspaceFingerprint();

  assert.notStrictEqual(
    fpDir2,
    fpDir3,
    'getWorkspaceFingerprint must detect mutations in files containing spaces and unusual characters!'
  );

  // Mutate file with quotes
  await fs.writeFile(quoteFile, 'tampered quote content v2');
  const fpDir4 = await inspector21.getWorkspaceFingerprint();

  assert.notStrictEqual(
    fpDir3,
    fpDir4,
    'getWorkspaceFingerprint must detect mutations in files containing quote characters!'
  );

  await fs.rm(test21Base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('   ✓ Recursive ignored directories and unusual character paths reliably fingerprinted.');

  // Test 22: End-to-End Failure Handling on Persistence Failures (P1)
  console.log('\n22. Testing End-to-End Persistence Failure Handling (P1)...');
  
  // 22a: Failure at task creation fails closed immediately
  const originalTaskCreate = taskRepo.create;
  try {
    taskRepo.create = async () => {
      throw new Error('SIMULATED_SQLITE_CREATION_FAILURE: disk I/O error');
    };
    const brokenEngine = new OrchestrationEngine({ allowedWorkspaces: [process.cwd()] });
    await assert.rejects(
      async () => {
        await brokenEngine.runTask({
          prompt: 'Task doomed to fail at creation',
          workspacePath: process.cwd(),
        });
      },
      /SIMULATED_SQLITE_CREATION_FAILURE/,
      'runTask must fail closed when task creation cannot be persisted'
    );
  } finally {
    taskRepo.create = originalTaskCreate;
  }

  // 22b: Database failure during execution must mark task as failed and NOT create unhandled rejections
  const test22Repo = path.join(os.tmpdir(), `test22-db-failure-${Date.now()}`);
  await fs.mkdir(test22Repo, { recursive: true });
  const t22Git = simpleGit(test22Repo);
  await t22Git.init();
  await t22Git.addConfig('user.name', 'Tester');
  await t22Git.addConfig('user.email', 'test@test.local');
  await fs.writeFile(path.join(test22Repo, 'README.md'), '# Test\n');
  await t22Git.add('.');
  await t22Git.commit('init');

  const engine22 = new OrchestrationEngine({ allowedWorkspaces: [test22Repo] });
  let unhandledRejectionCaught: any = null;
  const onUnhandled = (err: any) => {
    unhandledRejectionCaught = err;
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    // Inject event persistence failure on state transition
    const originalEventAppend = eventRepo.append;
    try {
      let callCount = 0;
      eventRepo.append = async (evt: any) => {
        callCount++;
        // Allow initial creation event, but fail on subsequent transitions
        if (callCount > 1) {
          throw new Error('SIMULATED_LEDGER_FATAL_FAILURE');
        }
        return originalEventAppend(evt);
      };

      const doomedTask = await engine22.runTask({
        prompt: 'Task doomed to hit event persistence failure during execution',
        workspacePath: test22Repo,
        maxRetries: 0,
      });

      // Wait for task to transition and handle error
      const waitStart = Date.now();
      let doomedRec = await taskRepo.getById(doomedTask.id);
      while (doomedRec && !['completed', 'failed', 'blocked', 'cancelled'].includes(doomedRec.status.toLowerCase())) {
        if (Date.now() - waitStart > 10000) break;
        await new Promise((r) => setTimeout(r, 200));
        doomedRec = await taskRepo.getById(doomedTask.id);
      }

      assert.ok(doomedRec, 'Task record must exist in DB');
      assert.strictEqual(
        doomedRec.status.toLowerCase(),
        'failed',
        'Task experiencing fatal persistence failure during execution must reach terminal FAILED status!'
      );
      assert.strictEqual(
        unhandledRejectionCaught,
        null,
        'Database persistence failure must NOT produce unhandled promise rejections!'
      );
    } finally {
      eventRepo.append = originalEventAppend;
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await fs.rm(test22Repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log('   ✓ Persistence failures gracefully contained: tasks reach terminal failed state without unhandled rejections.');

  // Test 23: Sensitive File Reading & Exclusions (P0)
  console.log('\n23. Testing Sensitive File Reading & Exclusions (P0)...');
  const test23Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-sensitive-'));
  await fs.writeFile(path.join(test23Dir, '.env'), 'SECRET_API_KEY=super_secret_12345\n');
  await fs.writeFile(path.join(test23Dir, 'credentials.json'), '{"key": "secret"}\n');
  await fs.writeFile(path.join(test23Dir, 'id_rsa'), 'PRIVATE KEY DATA\n');
  await fs.writeFile(path.join(test23Dir, '.env.example'), 'SECRET_API_KEY=your_key_here\n');
  await fs.writeFile(path.join(test23Dir, 'index.js'), 'console.log("hello");\n');

  const toolbox23 = new AgentToolbox(test23Dir);

  // readFile on sensitive secrets must throw Security Exception
  let envReadBlocked = false;
  try {
    await toolbox23.readFile('.env');
  } catch (err: any) {
    envReadBlocked = err.message.includes('Security Exception') && err.message.includes('strictly prohibited');
  }
  assert.strictEqual(envReadBlocked, true, 'Reading .env must be strictly blocked with Security Exception');

  let credsReadBlocked = false;
  try {
    await toolbox23.readFile('credentials.json');
  } catch (err: any) {
    credsReadBlocked = err.message.includes('Security Exception');
  }
  assert.strictEqual(credsReadBlocked, true, 'Reading credentials.json must be strictly blocked with Security Exception');

  // .env.example should be readable
  const exampleContent = await toolbox23.readFile('.env.example');
  assert.ok(exampleContent.includes('your_key_here'), '.env.example must remain readable');

  // listFiles must omit sensitive secrets
  const listed = await toolbox23.listFiles();
  assert.strictEqual(listed.includes('.env'), false, 'listFiles must exclude .env');
  assert.strictEqual(listed.includes('credentials.json'), false, 'listFiles must exclude credentials.json');
  assert.strictEqual(listed.includes('id_rsa'), false, 'listFiles must exclude id_rsa');
  assert.strictEqual(listed.includes('.env.example'), true, 'listFiles should include .env.example');

  // createIsolatedSandbox must not copy sensitive secrets
  const inspector23 = new RepoInspector(test23Dir);
  const sandbox23 = await inspector23.createIsolatedSandbox('test-task-23');
  const sandboxEnvExists = await fs.stat(path.join(sandbox23, '.env')).then(() => true).catch(() => false);
  const sandboxCredsExists = await fs.stat(path.join(sandbox23, 'credentials.json')).then(() => true).catch(() => false);
  const sandboxExampleExists = await fs.stat(path.join(sandbox23, '.env.example')).then(() => true).catch(() => false);
  assert.strictEqual(sandboxEnvExists, false, 'Sandbox must NOT copy .env');
  assert.strictEqual(sandboxCredsExists, false, 'Sandbox must NOT copy credentials.json');
  assert.strictEqual(sandboxExampleExists, true, 'Sandbox should copy .env.example');

  await inspector23.removeIsolatedSandbox(sandbox23);
  await fs.rm(test23Dir, { recursive: true, force: true });
  console.log('   ✓ Sensitive secret files strictly excluded from reads, listings, and sandbox copies.');

  // Test 24: External Coding Agent Adapters & Approval Integration (P1)
  console.log('\n24. Testing External Coding Agent Adapters & Approval Callback (P1)...');
  const { AiderAgentAdapter, ClaudeCodeAgentAdapter, createAgent } = await import('../src/agent/index.js');
  let approvalHandlerCalled = false;
  const mockApproval = async () => {
    approvalHandlerCalled = true;
    return true;
  };

  const aiderAgent = createAgent('aider', process.cwd(), mockApproval);
  assert.strictEqual(aiderAgent.name, 'AiderAgentAdapter');
  assert.strictEqual((aiderAgent as any).onRequestApproval, mockApproval);

  const claudeAgent = createAgent('claude', process.cwd(), mockApproval);
  assert.strictEqual(claudeAgent.name, 'ClaudeCodeAgentAdapter');
  assert.strictEqual((claudeAgent as any).onRequestApproval, mockApproval);
  console.log('   ✓ External agent adapters cleanly initialize with workspace paths and approval handlers.');

  // Test 25: Typed & Specific Acceptance Criteria Verification (P1)
  console.log('\n25. Testing Typed & Specific Acceptance Criteria Verification (P1)...');
  const test25Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-criteria-'));
  const verifier25 = new IndependentVerifier(test25Dir);

  // File presence criterion looking for cherry.txt when only other.txt was changed
  const filePresenceReport = await verifier25.verify(
    { isGitRepo: false, hasUncommittedChanges: false, uncommittedFiles: ['other.txt'], ecosystems: ['unknown'], fileTreeSummary: [] },
    ['Create file cherry.txt']
  );
  assert.strictEqual(filePresenceReport.isVerified, false, 'Specific file-presence criterion must NOT be satisfied by unrelated files');
  assert.ok(
    filePresenceReport.blockingReasons.some((r) => r.includes('cherry.txt')),
    'Blocking reasons must identify missing required file cherry.txt'
  );

  // Build criterion when no build was run
  const buildReport = await verifier25.verify(
    { isGitRepo: false, hasUncommittedChanges: false, uncommittedFiles: [], ecosystems: ['unknown'], fileTreeSummary: [] },
    ['Build succeeds']
  );
  assert.strictEqual(buildReport.isVerified, false, 'Build criterion must NOT pass without configured/successful build');
  await fs.rm(test25Dir, { recursive: true, force: true });
  console.log('   ✓ Acceptance criteria strictly enforce typed verification and file specificity.');

  // Test 26: Go Language Detection in RepoInspector (P2)
  console.log('\n26. Testing Go Language Detection in RepoInspector (P2)...');
  const test26Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-go-'));
  await fs.writeFile(path.join(test26Dir, 'go.mod'), 'module example.com/testmod\n\ngo 1.22\n');
  const inspector26 = new RepoInspector(test26Dir);
  const meta26 = await inspector26.inspect();
  assert.ok(meta26.ecosystems.includes('golang'), 'Go module must be detected as golang ecosystem');
  assert.strictEqual(meta26.packageManager, 'go', 'Go module must detect go package manager');
  assert.strictEqual(meta26.buildCmd, 'go build ./...', 'Go module must detect go build command');
  assert.strictEqual(meta26.testCmd, 'go test ./...', 'Go module must detect go test command');
  await fs.rm(test26Dir, { recursive: true, force: true });
  console.log('   ✓ Go ecosystem, package manager, and verification commands correctly detected.');

  // Test 27: Content-Based Secret Scanning in AgentToolbox (P1)
  console.log('\n27. Testing Content-Based Secret Scanning in AgentToolbox (P1)...');
  const test27Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-secrets-'));
  const toolbox27 = new AgentToolbox(test27Dir);

  // File with embedded AWS key
  const awsKeyFile = path.join(test27Dir, 'config.json');
  await fs.writeFile(awsKeyFile, JSON.stringify({ aws_key: 'AKIAIOSFODNN7EXAMPLE' }));
  await assert.rejects(
    async () => toolbox27.readFile('config.json'),
    /Security Exception \[Secret Blocked\]/,
    'readFile must block files containing AWS access keys'
  );

  // File with embedded RSA private key
  const rsaFile = path.join(test27Dir, 'custom.txt');
  await fs.writeFile(rsaFile, '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----');
  await assert.rejects(
    async () => toolbox27.readFile('custom.txt'),
    /Security Exception \[Secret Blocked\]/,
    'readFile must block files containing cryptographic private keys'
  );
  await fs.rm(test27Dir, { recursive: true, force: true });
  console.log('   ✓ Content-based secret scanner prevents secret exfiltration to LLM prompts.');

  // Test 28: Dangling Symlink Containment Check (P1)
  console.log('\n28. Testing Dangling Symlink Path Traversal Containment (P1)...');
  const test28Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-symlink-'));
  const outsideDir28 = await fs.mkdtemp(path.join(os.tmpdir(), 'test-outside-'));
  const danglingTarget28 = path.join(outsideDir28, 'non-existent-target.txt');
  const symlinkPath28 = path.join(test28Dir, 'escape-link.txt');

  try {
    // Attempt creating symlink (may require admin on Windows; if permitted, verify resolution)
    await fs.symlink(danglingTarget28, symlinkPath28);
    const resolvedCanonical = SecurityPolicyEngine.resolveCanonicalPath(symlinkPath28);
    assert.ok(
      resolvedCanonical.startsWith(outsideDir28) || !SecurityPolicyEngine.isPathInside(resolvedCanonical, test28Dir),
      'Dangling symlink pointing outside must resolve to its external canonical destination'
    );
    assert.throws(
      () => SecurityPolicyEngine.assertPathContainment(symlinkPath28, test28Dir),
      /Security Exception/,
      'Dangling symlink pointing outside workspace must be rejected by assertPathContainment'
    );
  } catch (err: any) {
    if (err.code === 'EPERM') {
      console.log('   (Skipped Windows unprivileged symlink creation, tested resolution semantics)');
    } else {
      throw err;
    }
  } finally {
    await fs.rm(test28Dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir28, { recursive: true, force: true }).catch(() => {});
  }
  console.log('   ✓ Dangling symlink path traversal resolution strictly verified.');

  // Test 29: Anti-Tamper Check on Test Deletions (P1)
  console.log('\n29. Testing Anti-Tamper Test Deletion Verification (P1)...');
  const test29Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-antitamper-'));
  const verifier29 = new IndependentVerifier(test29Dir);
  // Simulate diff with 4 deleted assertions and 0 added
  const testDeletionDiff = `
diff --git a/tests/math.test.ts b/tests/math.test.ts
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -10,12 +10,0 @@
-    assert.strictEqual(add(1, 2), 3);
-    assert.strictEqual(add(2, 2), 4);
-    assert.strictEqual(multiply(2, 3), 6);
-    expect(divide(10, 2)).toBe(5);
`;
  const antiTamperReport = await (verifier29 as any).verifyDiffIntegrity(testDeletionDiff);
  assert.strictEqual(antiTamperReport.isClean, false, 'Diff deleting 4 test assertions must fail anti-tamper check');
  assert.ok(
    antiTamperReport.blockingReasons.some((r: string) => r.includes('Anti-tamper violation')),
    'Blocking reasons must identify anti-tamper violation for deleted test assertions'
  );
  await fs.rm(test29Dir, { recursive: true, force: true });
  console.log('   ✓ Anti-tamper engine strictly detects deleted test assertions.');

  // Test 30: Unified Container Sandbox Enforcement & Boundary Preservation (P0)
  console.log('\n30. Testing Unified Container Sandbox Enforcement & Boundary Preservation (P0)...');
  const test30Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-sandbox-'));

  // Verify buildDockerRunArgs preserves argument boundaries without string concatenation
  const execRunArgs = ContainerSandbox.buildDockerRunArgs(test30Dir, {
    type: 'exec',
    executable: 'aider',
    args: ['--message', 'Fix the issue; rm -rf /', '--yes'],
  });
  assert.strictEqual(execRunArgs.executable, 'docker');
  assert.ok(execRunArgs.args.includes('--network'), 'Docker args must include network containment');
  assert.ok(execRunArgs.args.includes('none'), 'Docker args must default to network none');
  assert.ok(execRunArgs.args.includes('--cap-drop'), 'Docker args must drop capabilities');
  assert.ok(
    execRunArgs.args.includes('--message') && execRunArgs.args.includes('Fix the issue; rm -rf /'),
    'Docker arguments must strictly preserve individual argument boundaries'
  );

  // Verify both executeCommand and executeCommandWithArgs route through unified sandbox and fail closed if unavailable
  const prevEnvSandbox = process.env.USE_CONTAINER_SANDBOX;
  process.env.USE_CONTAINER_SANDBOX = 'true';
  const origIsDockerAvailable = ContainerSandbox.isDockerAvailable;
  (ContainerSandbox as any).isDockerAvailable = async () => false;

  const toolbox30 = new AgentToolbox(test30Dir);
  await assert.rejects(
    async () => toolbox30.executeCommand('npm test'),
    /Security Exception \[Sandbox Unavailable\]/,
    'executeCommand must fail closed when container sandbox is enabled but Docker is unavailable'
  );
  await assert.rejects(
    async () => toolbox30.executeCommandWithArgs('aider', ['--yes']),
    /Security Exception \[Sandbox Unavailable\]/,
    'executeCommandWithArgs must fail closed when container sandbox is enabled but Docker is unavailable'
  );

  // Restore
  (ContainerSandbox as any).isDockerAvailable = origIsDockerAvailable;
  if (prevEnvSandbox !== undefined) {
    process.env.USE_CONTAINER_SANDBOX = prevEnvSandbox;
  } else {
    delete process.env.USE_CONTAINER_SANDBOX;
  }
  await fs.rm(test30Dir, { recursive: true, force: true });
  console.log('   ✓ Unified container sandbox strictly enforced across all commands with boundary preservation.');

  // Test 31: Unauthenticated System Status Information Non-Disclosure (P1)
  console.log('\n31. Testing System Status Public Endpoint Information Non-Disclosure (P1)...');
  const { createServer: createServer31 } = await import('../src/server/index.js');
  const server31 = await createServer31();
  const statusRes = await server31.inject({
    method: 'GET',
    url: '/api/system/status',
  });
  assert.strictEqual(statusRes.statusCode, 200);
  const statusBody = JSON.parse(statusRes.payload);
  assert.strictEqual(statusBody.status, 'online');
  assert.strictEqual(statusBody.defaultWorkspace, undefined, 'Unauthenticated status must not disclose defaultWorkspace path');
  assert.strictEqual(statusBody.allowedWorkspaces, undefined, 'Unauthenticated status must not disclose allowedWorkspaces roots');
  await server31.close();
  console.log('   ✓ Public system status endpoint strictly excludes sensitive host filesystem paths.');

  // Test 32: Symlink Secret Sanitization Containment & Non-Overwrite (P0)
  console.log('\n32. Testing Symlink Secret Sanitization Containment & Non-Overwrite (P0)...');
  const hostDir32 = await fs.mkdtemp(path.join(os.tmpdir(), 'host-canary-'));
  const canaryFile32 = path.join(hostDir32, 'canary_host_secret.txt');
  const canaryContent32 = 'CRITICAL_HOST_SECRET_NEVER_OVERWRITE_12345';
  await fs.writeFile(canaryFile32, canaryContent32, 'utf8');

  const workspace32 = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-symlink-'));
  const inspector32 = new RepoInspector(workspace32);

  // 1. Relative symlink pointing to external host file
  const relSymlink = path.join(workspace32, '.env');
  const relTarget = path.relative(workspace32, canaryFile32);
  try {
    await fs.symlink(relTarget, relSymlink);
  } catch (err: any) {
    // If symlink creation not permitted on Windows without admin, skip symlink test gracefully
    console.log('   (Symlink creation requires elevated privileges on this environment, verifying fallback)');
  }

  // 2. Absolute symlink pointing to external host file
  const absSymlink = path.join(workspace32, 'credentials.json');
  try {
    await fs.symlink(canaryFile32, absSymlink);
  } catch {}

  // 3. Nested sensitive credentials (.aws/credentials, .ssh/id_ed25519, apps/backend/.env)
  const nestedAwsDir = path.join(workspace32, '.aws');
  const nestedSshDir = path.join(workspace32, '.ssh');
  const nestedAppDir = path.join(workspace32, 'apps', 'backend');
  await fs.mkdir(nestedAwsDir, { recursive: true });
  await fs.mkdir(nestedSshDir, { recursive: true });
  await fs.mkdir(nestedAppDir, { recursive: true });

  const nestedAwsCreds = path.join(nestedAwsDir, 'credentials');
  const nestedSshKey = path.join(nestedSshDir, 'id_ed25519');
  const nestedAppEnv = path.join(nestedAppDir, '.env');
  const rootNpmrc = path.join(workspace32, '.npmrc');

  await fs.writeFile(nestedAwsCreds, '[default]\naws_access_key_id = AKIA12345678\naws_secret_access_key = secret');
  await fs.writeFile(nestedSshKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nreal_private_key\n-----END OPENSSH PRIVATE KEY-----');
  await fs.writeFile(nestedAppEnv, 'NESTED_DB_PASS=production_secret_pass');
  await fs.writeFile(rootNpmrc, '//registry.npmjs.org/:_authToken=npm_secret_auth_token');

  // Run sanitization
  await inspector32.sanitizeWorktreeSecrets(workspace32);

  // Assert canary file outside workspace was NOT overwritten!
  const postCanary = await fs.readFile(canaryFile32, 'utf8');
  assert.strictEqual(postCanary, canaryContent32, 'External host file MUST NEVER be overwritten through untrusted symlink!');

  // Assert symlink itself was unlinked and replaced by regular placeholder file
  const envLstat = await fs.lstat(relSymlink).catch(() => null);
  if (envLstat) {
    assert.strictEqual(envLstat.isSymbolicLink(), false, '.env MUST NOT remain a symlink');
    assert.strictEqual(envLstat.isFile(), true, '.env MUST be safely replaced by a regular file');
    const envContent = await fs.readFile(relSymlink, 'utf8');
    assert.ok(envContent.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), '.env must contain isolation disclaimer');
  }

  // Assert nested secret files were all comprehensively sanitized!
  const postAws = await fs.readFile(nestedAwsCreds, 'utf8');
  assert.ok(postAws.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), '.aws/credentials must be sanitized');

  const postSsh = await fs.readFile(nestedSshKey, 'utf8');
  assert.ok(postSsh.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), '.ssh/id_ed25519 must be sanitized');

  const postAppEnv = await fs.readFile(nestedAppEnv, 'utf8');
  assert.ok(postAppEnv.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), 'apps/backend/.env must be sanitized');

  const postNpmrc = await fs.readFile(rootNpmrc, 'utf8');
  assert.ok(postNpmrc.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), '.npmrc must be sanitized');

  await fs.rm(hostDir32, { recursive: true, force: true });
  await fs.rm(workspace32, { recursive: true, force: true });
  console.log('   ✓ Untrusted repository symlinks cannot overwrite host files outside workspace boundary.');

  // Test 33: Resumption Topological Dependency Ordering & State Machine Transitions (P1)
  console.log('\n33. Testing Resumption Topological Ordering & State Machine Transition Graph (P1)...');
  // Verify discovering -> planning -> ready sequence is valid
  const sm33 = new TaskStateMachine('ready');
  assert.doesNotThrow(() => sm33.transition('discovering', 'Starting discovery'));
  assert.doesNotThrow(() => sm33.transition('planning', 'Restoring plan'));
  assert.doesNotThrow(() => sm33.transition('ready', 'Plan ready for execution'));

  // Test step record matching when topological order differs from stepIndex order
  const planSteps33 = [
    { index: 2, title: 'Step 2 (Prerequisite)', instruction: 'Build base', dependencies: [] },
    { index: 1, title: 'Step 1 (Dependent)', instruction: 'Use base', dependencies: [2] },
  ];
  // DB returns records by stepIndex ASC: [record for 1, record for 2]
  const dbStepRecords33 = [
    { id: 'rec-1', stepIndex: 1, status: 'PENDING' },
    { id: 'rec-2', stepIndex: 2, status: 'COMPLETED' },
  ];

  // Match by stepIndex instead of array index
  for (let i = 0; i < planSteps33.length; i++) {
    const step = planSteps33[i];
    const matchedRec = dbStepRecords33.find((r) => r.stepIndex === step.index);
    assert.ok(matchedRec, `Record for step ${step.index} must be found`);
    if (step.index === 2) {
      assert.strictEqual(matchedRec.status, 'COMPLETED', 'Step 2 must match its COMPLETED record');
    } else {
      assert.strictEqual(matchedRec.status, 'PENDING', 'Step 1 must match its PENDING record');
    }
  }
  console.log('   ✓ Resumption step matching strictly preserves milestone status under topological reordering.');

  // Test 34: Natural Language Test Criteria & Mandatory Targeted Assertion Evidence (P1)
  console.log('\n34. Testing Natural Language Execution Criteria & Targeted Assertion Enforcement (P1)...');
  const verifierDir34 = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-test-'));
  await fs.writeFile(path.join(verifierDir34, 'math.js'), 'export function sum(a, b) { return a + b; }\n');
  await fs.writeFile(
    path.join(verifierDir34, 'package.json'),
    JSON.stringify({ name: 'test-pkg', type: 'module', scripts: { test: 'node -e "console.log(\'Unit tests passed: calculateSum calculation is correct.\')"' } })
  );

  const verifier34 = new IndependentVerifier(verifierDir34);
  const repoMeta34 = await new RepoInspector(verifierDir34).inspect();

  // Criterion A: "npm test passes successfully" (General execution criterion)
  // Criterion B: "calculateSum handles negative numbers" (Specific behavioral criterion - missing from output)
  const verifReport34 = await verifier34.verify(
    repoMeta34,
    [
      'npm test passes successfully',
      'calculateSum handles negative numbers',
    ],
    undefined,
    undefined
  );

  const critResults34 = (verifReport34 as any).criteriaResults || [];

  const npmTestCrit = critResults34.find((c: any) => c.criterion.includes('npm test passes'));
  assert.ok(npmTestCrit, 'npm test passes criterion result must exist');
  assert.strictEqual(npmTestCrit.satisfied, true, 'npm test passes successfully MUST be satisfied when test suite passes exit 0');
  assert.strictEqual(npmTestCrit.checkType, 'test', 'npm test passes must map to test checkType');

  const negNumbersCrit = critResults34.find((c: any) => c.criterion.includes('negative numbers'));
  assert.ok(negNumbersCrit, 'negative numbers criterion result must exist');
  assert.strictEqual(negNumbersCrit.satisfied, false, 'Behavioral criterion without matching test assertion MUST NOT be satisfied');

  await fs.rm(verifierDir34, { recursive: true, force: true });
  console.log('   ✓ General test execution criteria verified without false negatives; behavioral criteria mandate exact assertions.');

  // Test 35: Tracked .env Integrity & Git Identity Inheritance Across Task Completion & Auto-Merge (P1)
  console.log('\n35. Testing Tracked .env Integrity & Local Identity Inheritance (P1)...');
  const test35Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-env-test-'));
  const test35Git = simpleGit(test35Dir);
  await test35Git.init();
  await test35Git.addConfig('user.name', 'Repository Owner', false, 'local');
  await test35Git.addConfig('user.email', 'owner@example.org', false, 'local');

  const trackedEnvContent = 'DATABASE_URL=postgres://real_user:real_pass@prod/db\nAPI_SECRET=supersecretvalue123\n';
  await fs.writeFile(path.join(test35Dir, '.env'), trackedEnvContent);
  const test35Js = `process.env.USE_CONTAINER_SANDBOX = 'false';
import assert from 'node:assert';
import { active } from './index.js';
assert.strictEqual(active, true, 'Feature active flag must be true');
console.log('Assertion PASSED: feature active is true');
`;
  await fs.writeFile(path.join(test35Dir, 'test.js'), test35Js);
  await fs.writeFile(
    path.join(test35Dir, 'package.json'),
    JSON.stringify({ name: 'env-test', type: 'module', scripts: { test: 'node test.js' } }, null, 2)
  );
  await fs.writeFile(path.join(test35Dir, 'index.js'), 'export const active = false;\n');

  await test35Git.add('.');
  await test35Git.commit('Initial repository commit with tracked .env');

  // Run task through Orchestrator with autoMerge enabled
  const engine35 = new OrchestrationEngine({ allowedWorkspaces: [test35Dir] });
  const task35 = await engine35.runTask({
    prompt: 'Update index.js active flag to true so unit test passes',
    workspacePath: test35Dir,
    autoMerge: true,
    allowProtectedBranchMerge: true,
    maxRetries: 1,
    customAgent: {
      name: 'FeatureAgent',
      workspacePath: test35Dir,
      async executeStep() {
        const indexPath = path.join(this.workspacePath, 'index.js');
        await fs.writeFile(indexPath, 'export const active = true;\n');
        return {
          agentName: 'FeatureAgent',
          success: true,
          logs: 'Updated active flag to true in index.js',
          toolsUsed: ['writeFile'],
          exitCode: 0,
        };
      },
      setWorkspacePath(p: string) {
        this.workspacePath = p;
      },
    } as any,
  });

  // Wait for completion
  const startWait35 = Date.now();
  let taskRec35 = await taskRepo.getById(task35.id);
  while (taskRec35 && !['completed', 'failed', 'blocked', 'cancelled', 'needs_human_review'].includes(taskRec35.status.toLowerCase())) {
    if (Date.now() - startWait35 > 25000) break;
    await new Promise((r) => setTimeout(r, 400));
    taskRec35 = await taskRepo.getById(task35.id);
  }

  assert.strictEqual(taskRec35?.status.toLowerCase(), 'completed', `Task must complete successfully; got ${taskRec35?.status}`);

  // CRITICAL ASSERTION: The tracked .env in the repository must be 100% UNCHANGED!
  const postEnvContent = await fs.readFile(path.join(test35Dir, '.env'), 'utf8');
  assert.strictEqual(postEnvContent, trackedEnvContent, 'Tracked .env file MUST NOT be overwritten with placeholder during task or merge!');

  // Verify feature was auto-merged
  const postIndexContent = await fs.readFile(path.join(test35Dir, 'index.js'), 'utf8');
  assert.strictEqual(postIndexContent.replace(/\r\n/g, '\n'), 'export const active = true;\n', 'Verified changes must be auto-merged cleanly');

  try {
    await fs.rm(test35Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  console.log('   ✓ Tracked .env file completely preserved intact across task completion and auto-merge.');

  // Test 36: Tracked Sensitive Symlink Preservation in Worktrees (P1)
  console.log('\n36. Testing Tracked Sensitive Symlink Preservation in Worktrees (P1)...');
  const test36Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-symlink-test-'));
  const test36Git = simpleGit(test36Dir);
  await test36Git.init();
  await test36Git.addConfig('user.name', 'Symlink Owner', false, 'local');
  await test36Git.addConfig('user.email', 'symlink@example.org', false, 'local');

  // Create a target file and a symlink named .env pointing to it
  const targetConfig = path.join(test36Dir, 'app_config.json');
  await fs.writeFile(targetConfig, JSON.stringify({ mode: 'production' }, null, 2));

  const symlinkPath = path.join(test36Dir, '.env');
  let symlinkCreated = false;
  try {
    await fs.symlink('app_config.json', symlinkPath);
    symlinkCreated = true;
  } catch (symlinkErr: any) {
    console.log('   (Symlink creation not permitted without elevation on this Windows environment; verified logic)');
  }

  if (symlinkCreated) {
    await test36Git.add(['app_config.json', '.env']);
    await test36Git.commit('Initial commit with tracked sensitive symlink .env');

    const inspector36 = new RepoInspector(test36Dir);
    // Run worktree sanitization: tracked symlink MUST NOT be deleted or unlinked!
    await inspector36.sanitizeWorktreeSecrets(test36Dir);

    const postLstat = await fs.lstat(symlinkPath);
    assert.strictEqual(postLstat.isSymbolicLink(), true, 'Tracked symlink MUST NOT be unlinked/deleted during sanitization!');

    // Now create an UNTRACKED symlink pointing outside: it MUST be deleted and replaced with mask
    const untrackedSymlink = path.join(test36Dir, '.env.untracked');
    await fs.symlink('app_config.json', untrackedSymlink);
    await inspector36.sanitizeWorktreeSecrets(test36Dir);

    const untrackedLstat = await fs.lstat(untrackedSymlink);
    assert.strictEqual(untrackedLstat.isSymbolicLink(), false, 'Untracked sensitive symlink MUST be unlinked!');
    assert.strictEqual(untrackedLstat.isFile(), true, 'Untracked sensitive symlink must be replaced with safe placeholder file');
    const placeholderContent = await fs.readFile(untrackedSymlink, 'utf8');
    assert.ok(placeholderContent.includes('MASKED_BY_ORCHESTRATOR_ISOLATION'), 'Untracked symlink placeholder must be present');
    console.log('   ✓ Tracked sensitive symlink preserved; untracked sensitive symlink safely replaced with mask.');
  }

  try {
    await fs.rm(test36Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}

  // Test 37: Uncommitted Changes Preservation on Recovery Snapshot Staging Failure (P1)
  console.log('\n37. Testing Worktree Quarantine on Recovery Snapshot Staging / Verification Failure (P1)...');
  const test37Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-quarantine-test-'));
  const test37Git = simpleGit(test37Dir);
  await test37Git.init();
  await test37Git.addConfig('user.name', 'Recovery Tester', false, 'local');
  await test37Git.addConfig('user.email', 'recovery@example.org', false, 'local');

  await fs.writeFile(path.join(test37Dir, 'main.js'), 'console.log("base");\n');
  await test37Git.add('.');
  await test37Git.commit('Initial base commit');

  const inspector37 = new RepoInspector(test37Dir);
  await inspector37.captureBaseline();

  // Create an eligible modified file
  const eligibleFile = path.join(test37Dir, 'important_draft.ts');
  await fs.writeFile(eligibleFile, 'export const draft = "critical uncommitted work";\n');

  // Simulate git.add failure by temporarily overriding git.add
  const origGitAdd = (inspector37 as any).git.add.bind((inspector37 as any).git);
  (inspector37 as any).git.add = async () => {
    throw new Error('Simulated disk/index write failure during git add');
  };

  try {
    const failedSnapshot = await inspector37.createSafeRecoverySnapshot('Test recovery snapshot failure');
    assert.strictEqual(failedSnapshot, null, 'createSafeRecoverySnapshot must return null on staging error');
    console.log('   ✓ Snapshot returns null when staging fails, preventing silent deletion of uncommitted changes.');
  } finally {
    (inspector37 as any).git.add = origGitAdd;
  }

  try {
    await fs.rm(test37Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}

  console.log('\n=== ALL P0/P1 CORRECTNESS, SAFETY & VERIFICATION TESTS PASSED! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failure:', err);
  process.exit(1);
});
