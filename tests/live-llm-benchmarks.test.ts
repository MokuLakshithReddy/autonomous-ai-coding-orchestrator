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
  benchmarkResult: 'PASSED' | 'FAILED';
  finalTaskStatus: string;
  agentResolution: 'Declared Complete' | 'Exhausted Iterations' | 'Execution Error' | 'Did Not Declare';
  verificationOutcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
  attempts: number;
  durationMs: number;
  costReport: string;
  tokensUsed: number;
  hiddenTestsPassed: number;
  totalHiddenTests: number;
}

async function extractExecutionAudit(taskId: string, fallbackStatus?: string): Promise<{
  finalTaskStatus: string;
  agentResolution: 'Declared Complete' | 'Exhausted Iterations' | 'Execution Error' | 'Did Not Declare';
  verificationOutcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
}> {
  const taskRec = await taskRepo.getById(taskId);
  const finalTaskStatus = (taskRec?.status || fallbackStatus || 'UNKNOWN').toUpperCase();

  const verifs = await verificationRepo.listForTask(taskId);
  const lastVerif = verifs[verifs.length - 1];
  const verificationOutcome = (lastVerif?.status || (finalTaskStatus === 'COMPLETED' ? 'PASSED' : 'FAILED')).toUpperCase() as any;

  const steps = await stepRepo.listForTask(taskId);
  let agentResolution: 'Declared Complete' | 'Exhausted Iterations' | 'Execution Error' | 'Did Not Declare' = 'Did Not Declare';
  for (const s of steps) {
    if (s.outputLog?.includes('[Agent] Step declared complete')) {
      agentResolution = 'Declared Complete';
      break;
    } else if (s.outputLog?.includes('exhausted max iterations')) {
      agentResolution = 'Exhausted Iterations';
    } else if (s.outputLog?.includes('[Error]') || s.outputLog?.includes('Execution failed')) {
      if (agentResolution !== 'Exhausted Iterations') {
        agentResolution = 'Execution Error';
      }
    }
  }

  return { finalTaskStatus, agentResolution, verificationOutcome };
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
        try {
          const wtDir = path.join(b1Dir, '.orchestrator_worktrees', task1.id);
          await git1.raw(['worktree', 'remove', '--force', wtDir]).catch(() => {});
          await git1.raw(['worktree', 'prune']).catch(() => {});
        } catch {}
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
    const audit1 = await extractExecutionAudit(task1.id, task1Rec?.status);
    const benchPass1 = isCompleted1 && audit1.verificationOutcome === 'PASSED' && hiddenTestsPassed1 === 5;

    results.push({
      name: 'Interval Merger Algorithm',
      category: 'Algorithmic Synthesis',
      benchmarkResult: benchPass1 ? 'PASSED' : 'FAILED',
      finalTaskStatus: audit1.finalTaskStatus,
      agentResolution: audit1.agentResolution,
      verificationOutcome: audit1.verificationOutcome,
      attempts: (task1Rec?.retryCount || 0) + 1,
      durationMs: duration1,
      costReport: cost1.costReport,
      tokensUsed: cost1.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed1,
      totalHiddenTests: 5,
    });

    console.log(
      `   ${benchPass1 ? '✓' : '❌'} Live Benchmark 1 Result: ${benchPass1 ? 'PASSED' : 'FAILED'} (Task: ${audit1.finalTaskStatus}, Agent: ${audit1.agentResolution}, Verif: ${audit1.verificationOutcome}, Hidden: ${hiddenTestsPassed1}/5)`
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
        try {
          const wtDir = path.join(b2Dir, '.orchestrator_worktrees', task2.id);
          await git2.raw(['worktree', 'remove', '--force', wtDir]).catch(() => {});
          await git2.raw(['worktree', 'prune']).catch(() => {});
        } catch {}
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
    const audit2 = await extractExecutionAudit(task2.id, task2Rec?.status);
    const benchPass2 = isCompleted2 && audit2.verificationOutcome === 'PASSED' && hiddenTestsPassed2 === 4;

    results.push({
      name: 'Tiered Pricing Calculator',
      category: 'Regression Prevention',
      benchmarkResult: benchPass2 ? 'PASSED' : 'FAILED',
      finalTaskStatus: audit2.finalTaskStatus,
      agentResolution: audit2.agentResolution,
      verificationOutcome: audit2.verificationOutcome,
      attempts: (task2Rec?.retryCount || 0) + 1,
      durationMs: duration2,
      costReport: cost2.costReport,
      tokensUsed: cost2.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed2,
      totalHiddenTests: 4,
    });

    console.log(
      `   ${benchPass2 ? '✓' : '❌'} Live Benchmark 2 Result: ${benchPass2 ? 'PASSED' : 'FAILED'} (Task: ${audit2.finalTaskStatus}, Agent: ${audit2.agentResolution}, Verif: ${audit2.verificationOutcome}, Regression: ${hiddenTestsPassed2}/4)`
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
        try {
          const wtDir = path.join(b3Dir, '.orchestrator_worktrees', task3.id);
          await git3.raw(['worktree', 'remove', '--force', wtDir]).catch(() => {});
          await git3.raw(['worktree', 'prune']).catch(() => {});
        } catch {}
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
    const audit3 = await extractExecutionAudit(task3.id, task3Rec?.status);
    const benchPass3 = isCompleted3 && audit3.verificationOutcome === 'PASSED' && hiddenTestsPassed3 === 4;

    results.push({
      name: 'Multi-File Service Contract',
      category: 'Coordinated Multi-File',
      benchmarkResult: benchPass3 ? 'PASSED' : 'FAILED',
      finalTaskStatus: audit3.finalTaskStatus,
      agentResolution: audit3.agentResolution,
      verificationOutcome: audit3.verificationOutcome,
      attempts: (task3Rec?.retryCount || 0) + 1,
      durationMs: duration3,
      costReport: cost3.costReport,
      tokensUsed: cost3.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed3,
      totalHiddenTests: 4,
    });

    console.log(
      `   ${benchPass3 ? '✓' : '❌'} Live Benchmark 3 Result: ${benchPass3 ? 'PASSED' : 'FAILED'} (Task: ${audit3.finalTaskStatus}, Agent: ${audit3.agentResolution}, Verif: ${audit3.verificationOutcome}, Multi-file: ${hiddenTestsPassed3}/4)`
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
        try {
          const wtDir = path.join(b4Dir, '.orchestrator_worktrees', task4.id);
          await git4.raw(['worktree', 'remove', '--force', wtDir]).catch(() => {});
          await git4.raw(['worktree', 'prune']).catch(() => {});
        } catch {}
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
    const audit4 = await extractExecutionAudit(task4.id, task4Rec?.status);
    const benchPass4 = isCompleted4 && audit4.verificationOutcome === 'PASSED' && hiddenTestsPassed4 === 4;

    results.push({
      name: 'ESM Dependency Configuration',
      category: 'Package & Resolution',
      benchmarkResult: benchPass4 ? 'PASSED' : 'FAILED',
      finalTaskStatus: audit4.finalTaskStatus,
      agentResolution: audit4.agentResolution,
      verificationOutcome: audit4.verificationOutcome,
      attempts: (task4Rec?.retryCount || 0) + 1,
      durationMs: duration4,
      costReport: cost4.costReport,
      tokensUsed: cost4.totalTokens,
      hiddenTestsPassed: hiddenTestsPassed4,
      totalHiddenTests: 4,
    });

    console.log(
      `   ${benchPass4 ? '✓' : '❌'} Live Benchmark 4 Result: ${benchPass4 ? 'PASSED' : 'FAILED'} (Task: ${audit4.finalTaskStatus}, Agent: ${audit4.agentResolution}, Verif: ${audit4.verificationOutcome}, Resolution: ${hiddenTestsPassed4}/4)`
    );

    // -------------------------------------------------------------------------
    // Report Summary
    // -------------------------------------------------------------------------
    console.log('\n========================================================================================================================================');
    console.log('                                  LIVE MODEL REPAIR BENCHMARKS: EMPIRICAL EVALUATION REPORT                                             ');
    console.log('========================================================================================================================================');
    console.log('| Benchmark                    | Category             | Result | Task Status | Agent Resolution     | Verif Outcome | Att | Duration | Hidden | Measured Spend / Tokens   |');
    console.log('|------------------------------|----------------------|--------|-------------|----------------------|---------------|-----|----------|--------|---------------------------|');
    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(28)} | ${r.category.padEnd(20)} | ${r.benchmarkResult.padEnd(6)} | ${r.finalTaskStatus.padEnd(11)} | ${r.agentResolution.padEnd(20)} | ${r.verificationOutcome.padEnd(13)} | ${String(r.attempts).padEnd(3)} | ${`${r.durationMs}ms`.padEnd(8)} | ${`${r.hiddenTestsPassed}/${r.totalHiddenTests}`.padEnd(6)} | ${r.costReport.padEnd(25)} |`
      );
    }
    console.log('========================================================================================================================================');

    const totalPassed = results.filter((r) => r.benchmarkResult === 'PASSED').length;
    const totalTokensAll = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    console.log(`Live Model Diverse Benchmark Pass Rate: ${Math.round((totalPassed / results.length) * 100)}% (${totalPassed}/${results.length})`);
    console.log(`Total Tokens Metered: ${totalTokensAll} tokens across ${results.length} diverse repair scenarios`);
    console.log('========================================================================================================================================\n');

    // Save report to disk as JSON and Markdown artifacts for CI diagnosability
    const reportArtifact = {
      timestamp: new Date().toISOString(),
      model: config.geminiModel,
      passRate: `${Math.round((totalPassed / results.length) * 100)}%`,
      totalPassed,
      totalBenchmarks: results.length,
      totalTokensAll,
      benchmarks: results,
    };
    await fs.writeFile('benchmark-report.json', JSON.stringify(reportArtifact, null, 2));

    let mdReport = `# Live Model Autonomous Repair Benchmarks Evaluation Report\n\n`;
    mdReport += `**Model**: \`${config.geminiModel}\` | **Date**: ${new Date().toISOString()} | **Pass Rate**: ${totalPassed}/${results.length} (${Math.round((totalPassed / results.length) * 100)}%)\n\n`;
    mdReport += `| Benchmark | Category | Result | Task Status | Agent Resolution | Verif Outcome | Attempts | Duration | Hidden Tests | Cost & Tokens |\n`;
    mdReport += `| :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const r of results) {
      mdReport += `| **${r.name}** | ${r.category} | **${r.benchmarkResult}** | \`${r.finalTaskStatus}\` | ${r.agentResolution} | \`${r.verificationOutcome}\` | ${r.attempts} | ${r.durationMs}ms | ${r.hiddenTestsPassed}/${r.totalHiddenTests} | ${r.costReport} |\n`;
    }
    mdReport += `\n**Total Tokens Metered**: ${totalTokensAll} tokens across ${results.length} benchmarks.\n`;
    await fs.writeFile('benchmark-report.md', mdReport);

    // P0 Requirement: Set a nonzero process exit code when any required benchmark fails
    if (totalPassed < results.length) {
      console.error(`\n❌ [P0 FAILURE] ${results.length - totalPassed} required live benchmarks failed. Preserving report and failing CI.`);
      process.exit(1);
    }

    assert.strictEqual(
      totalPassed,
      results.length,
      `All ${results.length} required live model benchmarks must pass (passed: ${totalPassed}/${results.length})`
    );
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
