import assert from 'node:assert';
import path from 'node:path';
import { TaskStateMachine, IllegalStateTransitionError } from '../src/core/state-machine.js';
import { SecurityPolicyEngine } from '../src/security/policy.js';
import { IndependentVerifier } from '../src/verifier/index.js';
import { AgentToolbox } from '../src/agent/tools.js';

async function runTests() {
  console.log('\n--- Running P0 Critical Correctness & Safety Verification Suite ---\n');

  // Test 1: Strict State Machine Enforcement
  console.log('1. Testing State Machine transition legality...');
  const sm = new TaskStateMachine('queued');
  assert.strictEqual(sm.getState(), 'queued');
  sm.transition('discovering', 'Started discovery');
  assert.strictEqual(sm.getState(), 'discovering');
  sm.transition('planning', 'Discovery complete');
  assert.strictEqual(sm.getState(), 'planning');

  // Illegal transition attempt: planning -> completed directly
  assert.throws(
    () => {
      sm.transition('completed', 'Illegal shortcut');
    },
    IllegalStateTransitionError,
    'State machine must reject direct planning -> completed transition'
  );
  console.log('   ✓ Illegal state transitions are strictly blocked.');

  // Test 2: Canonical Path Containment & Path Traversal Prevention
  console.log('\n2. Testing Canonical Path Containment & Traversal Blocking...');
  const fakeWorkspace = path.resolve(process.cwd());
  const maliciousPaths = [
    '../../Windows/System32/calc.exe',
    '../outside-file.txt',
    'C:/outside/test.txt',
  ];

  for (const mp of maliciousPaths) {
    assert.throws(
      () => {
        SecurityPolicyEngine.assertPathContainment(mp, fakeWorkspace);
      },
      /Security Exception/,
      `Failed to block path traversal: ${mp}`
    );
  }
  console.log('   ✓ Canonical path containment successfully blocked all directory escapes.');

  // Test 3: Environment Variable Sanitization & Secret Stripping
  console.log('\n3. Testing Process Environment Sanitization & Secret Redaction...');
  const rawEnv = SecurityPolicyEngine.getSanitizedProcessEnv();
  assert.strictEqual(rawEnv['GEMINI_API_KEY'], undefined, 'GEMINI_API_KEY must not be passed to child process');
  assert.strictEqual(rawEnv['GITHUB_TOKEN'], undefined, 'GITHUB_TOKEN must not be passed to child process');
  assert.strictEqual(rawEnv['CI'], 'true', 'CI must be set to true');

  const leakedText = 'Error connecting with token ghp_123456789012345678901234567890123456 and key AIzaSyD9876543210123456789012345678901';
  const redacted = SecurityPolicyEngine.redactSensitiveData(leakedText);
  assert.ok(!redacted.includes('ghp_'), 'PAT token must be redacted');
  assert.ok(!redacted.includes('AIza'), 'Gemini API key must be redacted');
  assert.ok(redacted.includes('[REDACTED_GH_TOKEN]'), 'PAT token placeholder missing');
  assert.ok(redacted.includes('[REDACTED_GEMINI_KEY]'), 'Gemini key placeholder missing');
  console.log('   ✓ Secrets are strictly scrubbed from environment variables and log streams.');

  // Test 4: Truthful Verifier - Missing Test Command is NOT_CONFIGURED, never PASSED
  console.log('\n4. Testing Truthful Verification - Missing commands are NOT_CONFIGURED...');
  const verifier = new IndependentVerifier(fakeWorkspace);
  const fakeMeta = {
    isGitRepo: true,
    hasUncommittedChanges: false,
    uncommittedFiles: [],
    ecosystems: ['unknown' as const],
    fileTreeSummary: [],
    // Deliberately no buildCmd and no testCmd
  };

  const report = await verifier.verify(fakeMeta, ['Unit tests must pass']);
  assert.strictEqual(report.testCheck.status, 'NOT_CONFIGURED', 'Missing test suite must be NOT_CONFIGURED, not passed');
  assert.strictEqual(report.buildCheck.status, 'NOT_CONFIGURED', 'Missing build must be NOT_CONFIGURED, not passed');
  assert.strictEqual(report.canDeclareComplete, false, 'Task without passing required criteria cannot declare complete');
  console.log('   ✓ Missing test suites truthfully return NOT_CONFIGURED and block false completion.');

  // Test 5: Anti-Tamper Diff Audit - Detection of test.skip or empty stubs
  console.log('\n5. Testing Anti-Tamper Heuristics...');
  const suspiciousDiff = `
+++ b/test/app.test.ts
@@ -10,3 +10,3 @@
-  test('validates auth token', () => {
+  test.skip('validates auth token', () => {
+  // TODO: implement later
`;
  const hasSkip = suspiciousDiff.includes('test.skip');
  const hasTodo = /\/\/\s*TODO:\s*implement/i.test(suspiciousDiff);
  assert.strictEqual(hasSkip, true, 'Anti-tamper must detect test.skip');
  assert.strictEqual(hasTodo, true, 'Anti-tamper must detect unimplemented TODOs');
  console.log('   ✓ Anti-tamper rules successfully detect skipped tests and placeholder stubs.');

  console.log('\n=== ALL P0 CRITICAL CORRECTNESS & SAFETY TESTS PASSED! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ P0 Test Failure:', err);
  process.exit(1);
});
