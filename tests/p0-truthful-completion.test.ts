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

  console.log('\n=== ALL P0/P1 CORRECTNESS, SAFETY & VERIFICATION TESTS PASSED! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failure:', err);
  process.exit(1);
});
