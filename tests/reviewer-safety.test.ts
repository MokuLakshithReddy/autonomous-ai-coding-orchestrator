import assert from 'node:assert';
import { LLMBrain } from '../src/llm/index.js';
import type { ExecutionPlan } from '../src/core/types.js';

async function runReviewerSafetyTests() {
  console.log('\n========================================================================');
  console.log('       TRUTHFUL REVIEWER & FALLBACK SAFETY VERIFICATION SUITE           ');
  console.log('========================================================================\n');

  const dummyPlan: ExecutionPlan = {
    summary: 'Plan to repair arithmetic bug',
    analysis: 'Fix calculation in math.js',
    acceptanceCriteria: ['Tests pass cleanly', 'Build succeeds with exit code 0'],
    steps: [
      {
        index: 1,
        title: 'Repair calculation',
        instruction: 'Fix add function in math.js',
        targetFiles: ['math.js'],
        dependencies: [],
        isSensitive: false,
      },
    ],
  };

  const sampleDiff = `
diff --git a/math.js b/math.js
--- a/math.js
+++ b/math.js
@@ -1,3 +1,3 @@
 export function calculateSum(a, b) {
-  return a - b;
+  return a + b;
 }
`;

  // Instantiate LLMBrain without API key (forces offline / fallback reviewer)
  const brain = new LLMBrain();
  // Ensure ai is null to test offline reviewer behavior
  (brain as any).ai = null;

  // ---------------------------------------------------------------------------
  // Test 1: Unavailable Reviewer with No Configured Tests
  // Requirement: Tests are missing/not configured -> Must NOT mark complete
  // ---------------------------------------------------------------------------
  console.log('Test 1: Reviewer fallback with NO CONFIGURED tests...');
  const noConfiguredReports = [
    '[PASSED] Build: PASSED, Test: NOT_CONFIGURED, Diff: Modified 1 files',
  ];
  const res1 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    noConfiguredReports,
    sampleDiff,
    false // no unresolved verification errors reported
  );
  assert.strictEqual(
    res1.isComplete,
    false,
    'Reviewer fallback must REJECT completion when tests are NOT_CONFIGURED.'
  );
  assert.strictEqual(res1.confidenceScore, 0);
  assert.ok(
    res1.unresolvedIssues.some((issue) => issue.toLowerCase().includes('not configured')),
    `Expected unconfigured tests rejection reason, got: ${JSON.stringify(res1.unresolvedIssues)}`
  );
  console.log('✓ Test 1 passed: Unconfigured tests strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // Test 2: Unavailable Reviewer with Failing Tests
  // Requirement: Test suite failed -> Must NOT mark complete
  // ---------------------------------------------------------------------------
  console.log('Test 2: Reviewer fallback with FAILING tests...');
  const failingReports = [
    '[FAILED] Build: PASSED, Test: FAILED, Diff: Modified 1 files',
  ];
  const res2 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    failingReports,
    sampleDiff,
    true // has unresolved verification errors
  );
  assert.strictEqual(
    res2.isComplete,
    false,
    'Reviewer fallback must REJECT completion when tests are FAILED.'
  );
  assert.strictEqual(res2.confidenceScore, 0);
  console.log('✓ Test 2 passed: Failing tests strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // Test 3: Unavailable Reviewer with Incomplete Verification (Empty Records)
  // Requirement: Verification incomplete/missing -> Must NOT mark complete
  // ---------------------------------------------------------------------------
  console.log('Test 3: Reviewer fallback with INCOMPLETE verification (empty reports)...');
  const emptyReports: string[] = [];
  const res3 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    emptyReports,
    sampleDiff,
    false
  );
  assert.strictEqual(
    res3.isComplete,
    false,
    'Reviewer fallback must REJECT completion when verification records are missing.'
  );
  assert.ok(
    res3.unresolvedIssues.some((issue) => issue.toLowerCase().includes('incomplete verification')),
    `Expected incomplete verification rejection reason, got: ${JSON.stringify(res3.unresolvedIssues)}`
  );
  console.log('✓ Test 3 passed: Incomplete verification strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // Test 4: Unavailable Reviewer with Unrun / Skipped Tests
  // Requirement: Tests not run or skipped -> Must NOT mark complete
  // ---------------------------------------------------------------------------
  console.log('Test 4: Reviewer fallback with SKIPPED / NOT_RUN tests...');
  const skippedReports = [
    '[PASSED] Build: PASSED, Test: NOT_RUN, Diff: Modified 1 files',
  ];
  const res4 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    skippedReports,
    sampleDiff,
    false
  );
  assert.strictEqual(
    res4.isComplete,
    false,
    'Reviewer fallback must REJECT completion when tests were NOT_RUN.'
  );
  console.log('✓ Test 4 passed: Unrun/skipped tests strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // Test 5: Unavailable Reviewer with Empty Diff (No code changes)
  // Requirement: Diff is empty -> Must NOT mark complete
  // ---------------------------------------------------------------------------
  console.log('Test 5: Reviewer fallback with EMPTY diff...');
  const passingReports = [
    '[PASSED] Build: PASSED, Test: PASSED, Diff: Clean verification',
  ];
  const res5 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    passingReports,
    '   ', // empty diff
    false
  );
  assert.strictEqual(
    res5.isComplete,
    false,
    'Reviewer fallback must REJECT completion when diff is empty.'
  );
  console.log('✓ Test 5 passed: Empty diff strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // Test 6: Unavailable Reviewer with Valid Independent Verification & Real Diff
  // Requirement: Tests passed cleanly, build passed, and real diff -> Authorizes completion
  // ---------------------------------------------------------------------------
  console.log('Test 6: Reviewer fallback with VALID independent verification & real diff...');
  const res6 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    passingReports,
    sampleDiff,
    false
  );
  assert.strictEqual(
    res6.isComplete,
    true,
    'Reviewer fallback must AUTHORIZE completion when independent tests cleanly pass with real diff.'
  );
  assert.ok(res6.confidenceScore >= 90);
  assert.strictEqual(res6.unresolvedIssues.length, 0);
  console.log('✓ Test 6 passed: Valid independent verification legitimately authorizes completion.\n');

  // ---------------------------------------------------------------------------
  // Test 7: Reviewer Model Schema Error / Network Error Safety
  // Requirement: When model returns invalid schema or throws, fallback enforces trusted verification
  // ---------------------------------------------------------------------------
  console.log('Test 7: Reviewer error handling fallback with missing tests...');
  // Mock model that throws a schema or execution error
  (brain as any).ai = {
    models: {
      generateContent: async () => {
        throw new Error('Malformed JSON schema: Unexpected token <');
      },
    },
  };

  const res7 = await brain.reviewOutcome(
    'Fix calculateSum in math.js',
    dummyPlan,
    noConfiguredReports, // tests not configured
    sampleDiff,
    false
  );
  assert.strictEqual(
    res7.isComplete,
    false,
    'Reviewer error fallback must NOT authorize completion when tests were missing.'
  );
  assert.strictEqual(res7.confidenceScore, 0);
  console.log('✓ Test 7 passed: Model error fallback fails closed when tests are missing.\n');

  console.log('========================================================================');
  console.log('   ALL 7 TRUTHFUL REVIEWER SAFETY TESTS PASSED SUCCESSFULLY!            ');
  console.log('========================================================================\n');
}

runReviewerSafetyTests().catch((err) => {
  console.error('❌ Reviewer safety tests failed:', err);
  process.exit(1);
});
