import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OrchestrationEngine } from '../src/orchestrator/engine.js';
import { BuiltInAutonomousAgent } from '../src/agent/index.js';
import { taskRepo, verificationRepo, initDatabase } from '../src/db/index.js';
import { config } from '../src/config/index.js';

interface BenchmarkResult {
  name: string;
  category: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  attempts: number;
  durationMs: number;
  costEstimate: string;
  regressionCaught: boolean;
  hiddenTestsPassed: number;
}

async function runLiveLLMBenchmarks() {
  console.log('\n========================================================================');
  console.log('   LIVE MODEL AUTONOMOUS REPAIR BENCHMARKS (UNSCRIPTED LLM EVALUATION)  ');
  console.log('========================================================================\n');

  const isLlmRequired = process.env.REQUIRE_LLM === 'true';
  if (!config.geminiApiKey) {
    if (isLlmRequired) {
      console.error('❌ [ERROR] GEMINI_API_KEY is required because REQUIRE_LLM=true, but no key was configured.');
      process.exit(1);
    }

    console.log('ℹ️  [NOTICE: SKIPPED] Live LLM autonomous repair benchmarks.');
    console.log('   Reason: No active GEMINI_API_KEY detected in environment.');
    console.log('   The deterministic pipeline benchmarks (tests/autonomous-repair-benchmarks.test.ts)');
    console.log('   execute in regular CI without requiring external model quotas.\n');
    console.log('   To execute live benchmarks against Gemini:');
    console.log('     $env:GEMINI_API_KEY = "your_api_key"');
    console.log('     npm run test:benchmarks:live\n');
    console.log('========================================================================\n');
    return;
  }

  await initDatabase();
  console.log(`✓ Active GEMINI_API_KEY detected. Evaluating model: ${config.geminiModel}\n`);

  const benchmarkBase = path.join(os.tmpdir(), `live-benchmarks-${Date.now()}`);
  await fs.mkdir(benchmarkBase, { recursive: true });

  const results: BenchmarkResult[] = [];

  try {
    // -------------------------------------------------------------------------
    // Benchmark 1: Unfamiliar Algorithm / Data Parser with Hidden Edge-Case Verification
    // -------------------------------------------------------------------------
    console.log('--- Live Benchmark 1: Unfamiliar Interval Merger with Edge Cases ---');
    const b1Dir = path.join(benchmarkBase, 'bench1-interval-merger');
    await fs.mkdir(b1Dir, { recursive: true });
    const git1 = simpleGit(b1Dir);
    await git1.init();
    await git1.addConfig('user.name', 'LiveBenchRunner');
    await git1.addConfig('user.email', 'bench@orchestrator.local');

    // Seed broken interval merger (fails on overlapping or unsorted intervals)
    await fs.writeFile(
      path.join(b1Dir, 'merger.js'),
      `export function mergeIntervals(intervals) {\n  // Buggy implementation: only returns input\n  return intervals;\n}\n`
    );

    // Public test in workspace
    await fs.writeFile(
      path.join(b1Dir, 'test.js'),
      `import assert from 'node:assert';
import { mergeIntervals } from './merger.js';

const res = mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]);
assert.deepStrictEqual(res, [[1, 6], [8, 10], [15, 18]]);
console.log('Public interval merger tests passed');
`
    );

    await fs.writeFile(
      path.join(b1Dir, 'package.json'),
      JSON.stringify(
        {
          name: 'live-bench1-interval-merger',
          type: 'module',
          scripts: { test: 'node test.js' },
        },
        null,
        2
      )
    );

    await git1.add('.');
    await git1.commit('Initial buggy interval merger');

    const agent1 = new BuiltInAutonomousAgent(b1Dir);
    const engine1 = new OrchestrationEngine({ allowedWorkspaces: [b1Dir] });

    engine1.on('event', (evt) => {
      console.log(`   [Bench1 Event] ${evt.type}: ${evt.payload?.message || evt.payload?.status || ''}`);
    });

    const startTime1 = Date.now();
    const task1 = await engine1.runTask({
      prompt:
        'In merger.js, fix the mergeIntervals(intervals) function so that intervals are sorted by start time (a[0] - b[0]) and overlapping or adjacent intervals (current[0] <= prev[1]) are merged into [prev[0], Math.max(prev[1], curr[1])]. Handle empty intervals array by returning []. Verify that node test.js passes cleanly.',
      workspacePath: b1Dir,
      maxRetries: 2,
      customAgent: agent1,
    });

    const maxWait = 240000;
    const startWait1 = Date.now();
    let task1Rec = await taskRepo.getById(task1.id);
    while (task1Rec && !['completed', 'failed', 'blocked', 'cancelled', 'needs_human_review', 'partially_completed'].includes(task1Rec.status.toLowerCase())) {
      if (Date.now() - startWait1 > maxWait) break;
      await new Promise((r) => setTimeout(r, 500));
      task1Rec = await taskRepo.getById(task1.id);
    }

    const duration1 = Date.now() - startTime1;
    const isCompleted1 = task1Rec?.status.toLowerCase() === 'completed';

    // Independent hidden verification test suite on repaired task branch
    let hiddenTestsPassed1 = 0;
    if (isCompleted1) {
      try {
        const taskBranch1 = `task/${task1.id.slice(0, 8)}`;
        await git1.checkout(taskBranch1);
        const { mergeIntervals } = await import(`file://${path.join(b1Dir, 'merger.js')}?v=${Date.now()}`);
        assert.deepStrictEqual(mergeIntervals([]), [], 'Empty input');
        hiddenTestsPassed1++;
        assert.deepStrictEqual(mergeIntervals([[1, 4]]), [[1, 4]], 'Single interval');
        hiddenTestsPassed1++;
        assert.deepStrictEqual(mergeIntervals([[4, 5], [1, 3]]), [[1, 3], [4, 5]], 'Unsorted disjoint');
        hiddenTestsPassed1++;
        assert.deepStrictEqual(mergeIntervals([[1, 4], [4, 5]]), [[1, 5]], 'Adjacent touching intervals');
        hiddenTestsPassed1++;
        assert.deepStrictEqual(mergeIntervals([[1, 10], [2, 3], [4, 8]]), [[1, 10]], 'Fully enclosed intervals');
        hiddenTestsPassed1++;
      } catch (err: any) {
        console.error('Hidden verification test failed:', err.message);
      }
    }

    results.push({
      name: 'Unfamiliar Algorithm (Interval Merger)',
      category: 'Algorithmic Repair & Synthesis',
      status: isCompleted1 && hiddenTestsPassed1 === 5 ? 'PASSED' : 'FAILED',
      attempts: (task1Rec?.retryCount || 0) + 1,
      durationMs: duration1,
      costEstimate: '~$0.002',
      regressionCaught: false,
      hiddenTestsPassed: hiddenTestsPassed1,
    });

    console.log(
      `   ${results[0].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 1 Result: ${results[0].status} (Hidden tests passed: ${hiddenTestsPassed1}/5)`
    );

    // -------------------------------------------------------------------------
    // Benchmark 2: Logic Bug with Hidden Regression Suite
    // -------------------------------------------------------------------------
    console.log('\n--- Live Benchmark 2: Logic Bug Repair with Hidden Regression Suite ---');
    const b2Dir = path.join(benchmarkBase, 'bench2-pricing-regression');
    await fs.mkdir(b2Dir, { recursive: true });
    const git2 = simpleGit(b2Dir);
    await git2.init();
    await git2.addConfig('user.name', 'LiveBenchRunner');
    await git2.addConfig('user.email', 'bench@orchestrator.local');

    // Pricing calculator with tiered discounts and coupon rules
    await fs.writeFile(
      path.join(b2Dir, 'pricing.js'),
      `export function calculateTotal(items, couponCode) {
  let subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // Deliberate bug: VIP discount applies wrong percentage (50% instead of 20%)
  // and breaks negative price protection
  if (couponCode === 'VIP20') {
    subtotal = subtotal * 0.5; // BUG
  }
  return Math.round(subtotal * 100) / 100;
}
`
    );

    // Public test that exposes the VIP20 discount bug
    await fs.writeFile(
      path.join(b2Dir, 'test.js'),
      `import assert from 'node:assert';
import { calculateTotal } from './pricing.js';

const res = calculateTotal([{ price: 100, quantity: 1 }], 'VIP20');
assert.strictEqual(res, 80, 'VIP20 must deduct exactly 20%, resulting in 80 for 100 subtotal');
console.log('Public pricing test passed');
`
    );

    await fs.writeFile(
      path.join(b2Dir, 'package.json'),
      JSON.stringify(
        {
          name: 'live-bench2-pricing-logic',
          type: 'module',
          scripts: { test: 'node test.js' },
        },
        null,
        2
      )
    );

    await git2.add('.');
    await git2.commit('Initial buggy pricing calculator');

    const agent2 = new BuiltInAutonomousAgent(b2Dir);
    const engine2 = new OrchestrationEngine({ allowedWorkspaces: [b2Dir] });

    engine2.on('event', (evt) => {
      console.log(`   [Bench2 Event] ${evt.type}: ${evt.payload?.message || evt.payload?.status || ''}`);
    });

    const startTime2 = Date.now();
    const task2 = await engine2.runTask({
      prompt:
        'In pricing.js, fix calculateTotal(items, couponCode) so VIP20 deducts 20% (subtotal * 0.8) and node test.js passes cleanly. Do not modify subtotal for missing or unknown coupons.',
      workspacePath: b2Dir,
      maxRetries: 2,
      customAgent: agent2,
    });

    const startWait2 = Date.now();
    let task2Rec = await taskRepo.getById(task2.id);
    while (task2Rec && !['completed', 'failed', 'blocked', 'cancelled', 'needs_human_review', 'partially_completed'].includes(task2Rec.status.toLowerCase())) {
      if (Date.now() - startWait2 > maxWait) break;
      await new Promise((r) => setTimeout(r, 500));
      task2Rec = await taskRepo.getById(task2.id);
    }

    const duration2 = Date.now() - startTime2;
    const isCompleted2 = task2Rec?.status.toLowerCase() === 'completed';

    // Hidden regression suite on repaired task branch
    let hiddenTestsPassed2 = 0;
    if (isCompleted2) {
      try {
        const taskBranch2 = `task/${task2.id.slice(0, 8)}`;
        await git2.checkout(taskBranch2);
        const { calculateTotal } = await import(`file://${path.join(b2Dir, 'pricing.js')}?v=${Date.now()}`);
        assert.strictEqual(calculateTotal([{ price: 50, quantity: 2 }], undefined), 100, 'Standard subtotal without coupon');
        hiddenTestsPassed2++;
        assert.strictEqual(calculateTotal([{ price: 50, quantity: 2 }], 'UNKNOWN'), 100, 'Unknown coupon ignored');
        hiddenTestsPassed2++;
        assert.strictEqual(calculateTotal([{ price: 200, quantity: 1 }], 'VIP20'), 160, 'VIP20 on higher subtotal');
        hiddenTestsPassed2++;
        assert.strictEqual(calculateTotal([], 'VIP20'), 0, 'Empty cart');
        hiddenTestsPassed2++;
      } catch (err: any) {
        console.error('Hidden regression test failed:', err.message);
      }
    }

    results.push({
      name: 'Logic Bug with Hidden Regression Suite',
      category: 'Regression Prevention',
      status: isCompleted2 && hiddenTestsPassed2 === 4 ? 'PASSED' : 'FAILED',
      attempts: (task2Rec?.retryCount || 0) + 1,
      durationMs: duration2,
      costEstimate: '~$0.002',
      regressionCaught: hiddenTestsPassed2 === 4,
      hiddenTestsPassed: hiddenTestsPassed2,
    });

    console.log(
      `   ${results[1].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 2 Result: ${results[1].status} (Regression tests passed: ${hiddenTestsPassed2}/4)`
    );

    // -------------------------------------------------------------------------
    // Report Summary
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('       LIVE MODEL REPAIR BENCHMARKS: EVALUATION REPORT                  ');
    console.log('========================================================================');
    console.log('| Benchmark | Category | Result | Attempts | Latency | Hidden Tests | Cost |');
    console.log('|-----------|----------|--------|----------|---------|--------------|------|');
    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(25)} | ${r.category.padEnd(20)} | ${r.status.padEnd(6)} | ${String(r.attempts).padEnd(8)} | ${`${r.durationMs}ms`.padEnd(7)} | ${String(r.hiddenTestsPassed).padEnd(12)} | ${r.costEstimate} |`
      );
    }
    console.log('========================================================================');

    const totalPassed = results.filter((r) => r.status === 'PASSED').length;
    console.log(`Live Model Benchmark Pass Rate: ${Math.round((totalPassed / results.length) * 100)}% (${totalPassed}/${results.length})`);
    console.log('========================================================================\n');

    // Acceptance Criteria: High-performing live model must achieve >= 50% pass rate on hidden tests
    assert.ok(totalPassed >= 1, `Live model benchmarks must demonstrate successful repair (passed: ${totalPassed}/${results.length})`);
  } finally {
    try {
      await fs.rm(benchmarkBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

runLiveLLMBenchmarks().catch((err) => {
  console.error('\n❌ Live LLM Benchmark Suite Failure:', err);
  process.exit(1);
});

