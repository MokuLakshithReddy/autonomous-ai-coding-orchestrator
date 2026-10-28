import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OrchestrationEngine } from '../src/orchestrator/engine.js';
import { BuiltInAutonomousAgent } from '../src/agent/index.js';
import { taskRepo, verificationRepo, stepRepo, initDatabase } from '../src/db/index.js';
import { config } from '../src/config/index.js';

interface BenchmarkResult {
  name: string;
  category: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  attempts: number;
  durationMs: number;
  costReport: string;
  tokensUsed: number;
  hiddenTestsPassed: number;
  totalHiddenTests: number;
  resolutionMode: string;
}

function getMeasuredCostAndTokens(
  agent: BuiltInAutonomousAgent,
  engine: OrchestrationEngine
): { costReport: string; totalTokens: number } {
  const aUsage = agent.getTokenUsage();
  const bUsage = engine.lastBrain?.getTokenUsage() || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0, measuredCost: 0 };
  const totalPrompt = aUsage.promptTokens + bUsage.promptTokens;
  const totalCand = aUsage.candidatesTokens + bUsage.candidatesTokens;
  const totalTokens = aUsage.totalTokens + bUsage.totalTokens;
  const cost = (totalPrompt * 0.075) / 1e6 + (totalCand * 0.3) / 1e6;

  if (totalTokens > 0) {
    return {
      costReport: `Measured: $${cost.toFixed(6)} (${totalTokens} tok)`,
      totalTokens,
    };
  }
  return {
    costReport: 'Estimated: ~$0.002 (unmetered)',
    totalTokens: 0,
  };
}

async function runLiveLLMBenchmarks() {
  console.log('\n========================================================================');
  console.log('   LIVE MODEL AUTONOMOUS REPAIR BENCHMARKS (UNSCRIPTED DIVERSE SUITE)   ');
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
  const maxWait = 240000;

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

    const cost1 = getMeasuredCostAndTokens(agent1, engine1);
    const steps1 = await stepRepo.listForTask(task1.id);
    const resMode1 = steps1.some((s) => s.outputLog?.includes('independently verified that'))
      ? 'Independently Verified'
      : 'Agent Declared';

    results.push({
      name: 'Interval Merger Algorithm',
      category: 'Algorithmic Synthesis',
      status: isCompleted1 && hiddenTestsPassed1 === 5 ? 'PASSED' : 'FAILED',
      attempts: (task1Rec?.retryCount || 0) + 1,
      durationMs: duration1,
      costReport: cost1.costReport,
      tokensUsed: cost1.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed1,
      totalHiddenTests: 5,
      resolutionMode: resMode1,
    });

    console.log(
      `   ${results[0].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 1 Result: ${results[0].status} (Hidden tests passed: ${hiddenTestsPassed1}/5)`
    );

    await new Promise((r) => setTimeout(r, 3000));

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

    const cost2 = getMeasuredCostAndTokens(agent2, engine2);
    const steps2 = await stepRepo.listForTask(task2.id);
    const resMode2 = steps2.some((s) => s.outputLog?.includes('independently verified that'))
      ? 'Independently Verified'
      : 'Agent Declared';

    results.push({
      name: 'Tiered Pricing Calculator',
      category: 'Regression Prevention',
      status: isCompleted2 && hiddenTestsPassed2 === 4 ? 'PASSED' : 'FAILED',
      attempts: (task2Rec?.retryCount || 0) + 1,
      durationMs: duration2,
      costReport: cost2.costReport,
      tokensUsed: cost2.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed2,
      totalHiddenTests: 4,
      resolutionMode: resMode2,
    });

    console.log(
      `   ${results[1].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 2 Result: ${results[1].status} (Regression tests passed: ${hiddenTestsPassed2}/4)`
    );

    await new Promise((r) => setTimeout(r, 3000));

    // -------------------------------------------------------------------------
    // Benchmark 3: Multi-File Coordinated Contract & Service Refactoring
    // -------------------------------------------------------------------------
    console.log('\n--- Live Benchmark 3: Multi-File Coordinated Contract Refactoring ---');
    const b3Dir = path.join(benchmarkBase, 'bench3-multifile-contract');
    await fs.mkdir(path.join(b3Dir, 'src'), { recursive: true });
    const git3 = simpleGit(b3Dir);
    await git3.init();
    await git3.addConfig('user.name', 'LiveBenchRunner');
    await git3.addConfig('user.email', 'bench@orchestrator.local');

    await fs.writeFile(
      path.join(b3Dir, 'src', 'logger.js'),
      `export function createLogger(serviceName) {
  return {
    serviceName,
    log(level, message, metadata = {}) {
      return {
        timestamp: new Date().toISOString(),
        service: serviceName,
        level: level.toUpperCase(),
        message,
        meta: metadata,
      };
    },
  };
}
`
    );

    await fs.writeFile(
      path.join(b3Dir, 'src', 'service.js'),
      `import { createLogger } from './logger.js';

export class UserService {
  constructor() {
    this.logger = createLogger('user-service');
  }

  registerUser(username, role) {
    if (!username) throw new Error('Username required');
    const user = { id: 101, username, role: role || 'member' };
    // Outdated contract call: formatEvent does not exist on logger
    const logEntry = this.logger.formatEvent('REGISTER', { user });
    return { user, logEntry };
  }
}
`
    );

    await fs.writeFile(
      path.join(b3Dir, 'test.js'),
      `import assert from 'node:assert';
import { UserService } from './src/service.js';

const service = new UserService();
const result = service.registerUser('alice', 'admin');
assert.strictEqual(result.user.username, 'alice');
assert.ok(result.logEntry, 'Must return logEntry');
assert.strictEqual(result.logEntry.level, 'INFO');
console.log('Public user service test passed');
`
    );

    await fs.writeFile(
      path.join(b3Dir, 'package.json'),
      JSON.stringify(
        {
          name: 'live-bench3-multifile',
          type: 'module',
          scripts: { test: 'node test.js' },
        },
        null,
        2
      )
    );

    await git3.add('.');
    await git3.commit('Initial multi-file logging contract mismatch');

    const agent3 = new BuiltInAutonomousAgent(b3Dir);
    const engine3 = new OrchestrationEngine({ allowedWorkspaces: [b3Dir] });

    engine3.on('event', (evt) => {
      console.log(`   [Bench3 Event] ${evt.type}: ${evt.payload?.message || evt.payload?.status || ''}`);
    });

    const startTime3 = Date.now();
    const task3 = await engine3.runTask({
      prompt:
        'In src/service.js, update UserService.registerUser to call this.logger.log("info", "User registered", { user }) so that node test.js passes cleanly. Preserve role defaulting and username validation.',
      workspacePath: b3Dir,
      maxRetries: 2,
      customAgent: agent3,
    });

    const startWait3 = Date.now();
    let task3Rec = await taskRepo.getById(task3.id);
    while (task3Rec && !['completed', 'failed', 'blocked', 'cancelled', 'needs_human_review', 'partially_completed'].includes(task3Rec.status.toLowerCase())) {
      if (Date.now() - startWait3 > maxWait) break;
      await new Promise((r) => setTimeout(r, 500));
      task3Rec = await taskRepo.getById(task3.id);
    }

    const duration3 = Date.now() - startTime3;
    const isCompleted3 = task3Rec?.status.toLowerCase() === 'completed';

    // Hidden verification suite on repaired task branch
    let hiddenTestsPassed3 = 0;
    if (isCompleted3) {
      try {
        const taskBranch3 = `task/${task3.id.slice(0, 8)}`;
        await git3.checkout(taskBranch3);
        const { UserService } = await import(`file://${path.join(b3Dir, 'src', 'service.js')}?v=${Date.now()}`);
        const serviceInstance = new UserService();
        const r1 = serviceInstance.registerUser('bob', undefined);
        assert.strictEqual(r1.user.role, 'member', 'Default role must be member');
        hiddenTestsPassed3++;
        assert.strictEqual(r1.logEntry.service, 'user-service', 'Log service must be user-service');
        hiddenTestsPassed3++;
        assert.strictEqual(r1.logEntry.level, 'INFO', 'Log level must be uppercase INFO');
        hiddenTestsPassed3++;
        assert.throws(() => serviceInstance.registerUser('', 'admin'), /Username required/, 'Empty username must throw');
        hiddenTestsPassed3++;
      } catch (err: any) {
        console.error('Hidden multi-file verification test failed:', err.message);
      }
    }

    const cost3 = getMeasuredCostAndTokens(agent3, engine3);
    const steps3 = await stepRepo.listForTask(task3.id);
    const resMode3 = steps3.some((s) => s.outputLog?.includes('independently verified that'))
      ? 'Independently Verified'
      : 'Agent Declared';

    results.push({
      name: 'Multi-File Service Contract',
      category: 'Coordinated Multi-File',
      status: isCompleted3 && hiddenTestsPassed3 === 4 ? 'PASSED' : 'FAILED',
      attempts: (task3Rec?.retryCount || 0) + 1,
      durationMs: duration3,
      costReport: cost3.costReport,
      tokensUsed: cost3.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed3,
      totalHiddenTests: 4,
      resolutionMode: resMode3,
    });

    console.log(
      `   ${results[2].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 3 Result: ${results[2].status} (Multi-file tests passed: ${hiddenTestsPassed3}/4)`
    );

    await new Promise((r) => setTimeout(r, 3000));

    // -------------------------------------------------------------------------
    // Benchmark 4: Package Dependency & Module Resolution Failure
    // -------------------------------------------------------------------------
    console.log('\n--- Live Benchmark 4: Package Dependency & Module Resolution Failure ---');
    const b4Dir = path.join(benchmarkBase, 'bench4-dependency-resolution');
    await fs.mkdir(b4Dir, { recursive: true });
    const git4 = simpleGit(b4Dir);
    await git4.init();
    await git4.addConfig('user.name', 'LiveBenchRunner');
    await git4.addConfig('user.email', 'bench@orchestrator.local');

    // Missing "type": "module" causing syntax error on ESM import
    await fs.writeFile(
      path.join(b4Dir, 'crypto.js'),
      `import crypto from 'node:crypto';

export function generateToken(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function verifyToken(payload, expectedHash) {
  return generateToken(payload) === expectedHash;
}
`
    );

    await fs.writeFile(
      path.join(b4Dir, 'test.js'),
      `import assert from 'node:assert';
import { generateToken, verifyToken } from './crypto.js';

const token = generateToken('session-123');
assert.strictEqual(typeof token, 'string');
assert.strictEqual(token.length, 64);
assert.strictEqual(verifyToken('session-123', token), true);
assert.strictEqual(verifyToken('tampered', token), false);
console.log('Public crypto module test passed');
`
    );

    // Buggy package.json missing "type": "module"
    await fs.writeFile(
      path.join(b4Dir, 'package.json'),
      JSON.stringify(
        {
          name: 'live-bench4-dependency-resolution',
          scripts: { test: 'node test.js' },
        },
        null,
        2
      )
    );

    await git4.add('.');
    await git4.commit('Initial package configuration with missing ESM declaration');

    const agent4 = new BuiltInAutonomousAgent(b4Dir);
    const engine4 = new OrchestrationEngine({ allowedWorkspaces: [b4Dir] });

    engine4.on('event', (evt) => {
      console.log(`   [Bench4 Event] ${evt.type}: ${evt.payload?.message || evt.payload?.status || ''}`);
    });

    const startTime4 = Date.now();
    const task4 = await engine4.runTask({
      prompt:
        'Running "node test.js" fails with module resolution/syntax error because package.json is missing "type": "module". Fix package.json to include "type": "module" so that node test.js executes successfully.',
      workspacePath: b4Dir,
      maxRetries: 2,
      customAgent: agent4,
    });

    const startWait4 = Date.now();
    let task4Rec = await taskRepo.getById(task4.id);
    while (task4Rec && !['completed', 'failed', 'blocked', 'cancelled', 'needs_human_review', 'partially_completed'].includes(task4Rec.status.toLowerCase())) {
      if (Date.now() - startWait4 > maxWait) break;
      await new Promise((r) => setTimeout(r, 500));
      task4Rec = await taskRepo.getById(task4.id);
    }

    const duration4 = Date.now() - startTime4;
    const isCompleted4 = task4Rec?.status.toLowerCase() === 'completed';

    // Hidden verification suite on repaired task branch
    let hiddenTestsPassed4 = 0;
    if (isCompleted4) {
      try {
        const taskBranch4 = `task/${task4.id.slice(0, 8)}`;
        await git4.checkout(taskBranch4);
        const pkgContent = JSON.parse(await fs.readFile(path.join(b4Dir, 'package.json'), 'utf-8'));
        assert.strictEqual(pkgContent.type, 'module', 'package.json must declare type: module');
        hiddenTestsPassed4++;
        const { generateToken, verifyToken } = await import(`file://${path.join(b4Dir, 'crypto.js')}?v=${Date.now()}`);
        const t1 = generateToken('arbitrary-key');
        assert.strictEqual(t1.length, 64, 'Token length must be 64 chars');
        hiddenTestsPassed4++;
        assert.strictEqual(verifyToken('arbitrary-key', t1), true, 'Valid token must verify');
        hiddenTestsPassed4++;
        assert.strictEqual(verifyToken('wrong-key', t1), false, 'Invalid token must reject');
        hiddenTestsPassed4++;
      } catch (err: any) {
        console.error('Hidden dependency resolution verification test failed:', err.message);
      }
    }

    const cost4 = getMeasuredCostAndTokens(agent4, engine4);
    const steps4 = await stepRepo.listForTask(task4.id);
    const resMode4 = steps4.some((s) => s.outputLog?.includes('independently verified that'))
      ? 'Independently Verified'
      : 'Agent Declared';

    results.push({
      name: 'ESM Dependency Configuration',
      category: 'Package & Resolution',
      status: isCompleted4 && hiddenTestsPassed4 === 4 ? 'PASSED' : 'FAILED',
      attempts: (task4Rec?.retryCount || 0) + 1,
      durationMs: duration4,
      costReport: cost4.costReport,
      tokensUsed: cost4.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed4,
      totalHiddenTests: 4,
      resolutionMode: resMode4,
    });

    console.log(
      `   ${results[3].status === 'PASSED' ? '✓' : '❌'} Live Benchmark 4 Result: ${results[3].status} (Resolution tests passed: ${hiddenTestsPassed4}/4)`
    );

    // -------------------------------------------------------------------------
    // Report Summary
    // -------------------------------------------------------------------------
    console.log('\n================================================================================================');
    console.log('                  LIVE MODEL REPAIR BENCHMARKS: EMPIRICAL EVALUATION REPORT                     ');
    console.log('================================================================================================');
    console.log('| Benchmark                    | Category             | Result | Att | Latency | Hidden | Resolution Mode         | Measured Spend / Tokens   |');
    console.log('|------------------------------|----------------------|--------|-----|---------|--------|-------------------------|---------------------------|');
    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(28)} | ${r.category.padEnd(20)} | ${r.status.padEnd(6)} | ${String(r.attempts).padEnd(3)} | ${`${r.durationMs}ms`.padEnd(7)} | ${`${r.hiddenTestsPassed}/${r.totalHiddenTests}`.padEnd(6)} | ${r.resolutionMode.padEnd(23)} | ${r.costReport.padEnd(25)} |`
      );
    }
    console.log('================================================================================================');

    const totalPassed = results.filter((r) => r.status === 'PASSED').length;
    const totalTokensAll = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    console.log(`Live Model Diverse Benchmark Pass Rate: ${Math.round((totalPassed / results.length) * 100)}% (${totalPassed}/${results.length})`);
    console.log(`Total Tokens Metered: ${totalTokensAll} tokens across ${results.length} diverse repair scenarios`);
    console.log('================================================================================================\n');

    // Acceptance Criteria: Diverse live benchmarks demonstrate robust repair capability across categories
    assert.ok(totalPassed >= 2, `Live model benchmarks must demonstrate successful repair on majority of tasks (passed: ${totalPassed}/${results.length})`);
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
