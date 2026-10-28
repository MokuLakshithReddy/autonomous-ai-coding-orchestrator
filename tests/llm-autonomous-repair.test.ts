import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OrchestrationEngine } from '../src/orchestrator/engine.js';
import { BuiltInAutonomousAgent } from '../src/agent/index.js';
import { taskRepo, stepRepo, verificationRepo, initDatabase } from '../src/db/index.js';
import { config } from '../src/config/index.js';

async function runLiveLLMRepairIntegrationTest() {
  console.log('\n====================================================================');
  console.log('   LIVE LLM AUTONOMOUS REPAIR INTEGRATION TEST (UNSCRIPTED)         ');
  console.log('====================================================================\n');

  if (!config.geminiApiKey) {
    console.log('ℹ️  [NOTICE: SKIPPED] Live LLM autonomous repair integration test.');
    console.log('   Reason: No GEMINI_API_KEY is configured in environment or .env.');
    console.log('   The deterministic agent regression test (tests/autonomous-repair-loop.test.ts)');
    console.log('   runs in CI without requiring an active external LLM quota.');
    console.log('\n   To execute this unscripted test against live Gemini:');
    console.log('     $env:GEMINI_API_KEY = "your_key"');
    console.log('     npm run test:llm\n');
    console.log('====================================================================\n');
    return;
  }

  console.log(`✓ Active GEMINI_API_KEY detected. Using model: ${config.geminiModel}`);
  await initDatabase();

  // 1. Create a disposable Git repository with a seeded calculation bug
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-live-llm-'));
  const repoDir = path.join(tmpBase, 'test-repo');
  await fs.mkdir(repoDir, { recursive: true });

  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.name', 'Live LLM Test');
  await git.addConfig('user.email', 'live-llm@orchestrator.local');

  const pkgJson = {
    name: 'live-llm-repair-repo',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node test.js',
    },
  };
  await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // Seeded bug
  const buggyMath = `export function calculateSum(a, b) {\n  return a - b;\n}\n`;
  await fs.writeFile(path.join(repoDir, 'math.js'), buggyMath);

  const testFile = `import assert from 'node:assert';
import { calculateSum } from './math.js';

try {
  const result = calculateSum(2, 3);
  assert.strictEqual(result, 5, \`Expected 5 but got \${result}\`);
  console.log('Unit tests passed: calculateSum calculation is correct.');
  process.exit(0);
} catch (err) {
  console.error('Test failed:', err.message);
  process.exit(1);
}
`;
  await fs.writeFile(path.join(repoDir, 'test.js'), testFile);

  await git.add('.');
  await git.commit('Initial commit with seeded calculation bug');

  console.log('1. Created disposable repository at:', repoDir);

  // 2. Instantiate BuiltInAutonomousAgent using the LIVE configured LLM engine
  console.log('2. Instantiating BuiltInAutonomousAgent with live Gemini client...');
  const liveAgent = new BuiltInAutonomousAgent(repoDir);

  // 3. Dispatch task through OrchestrationEngine
  console.log('3. Dispatching OrchestrationEngine task with live agent...');
  const orchestrator = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });

  const task = await orchestrator.runTask({
    prompt: 'Fix the calculateSum function in math.js so that node test.js passes',
    workspacePath: repoDir,
    maxRetries: 3,
    customAgent: liveAgent,
  });

  // Poll until terminal state
  const maxWaitMs = 60000;
  const startWait = Date.now();
  let latestTask = await taskRepo.getById(task.id);

  while (latestTask && !['completed', 'failed', 'blocked', 'cancelled'].includes(latestTask.status.toLowerCase())) {
    if (Date.now() - startWait > maxWaitMs) {
      throw new Error(`Timeout waiting for live LLM task ${task.id} to finish (current state: ${latestTask.status})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    latestTask = await taskRepo.getById(task.id);
  }

  // 4. Verify autonomous repair results
  console.log('\n4. Verifying live LLM execution results...');
  assert.ok(latestTask, 'Task record must exist in durable database');

  if (latestTask.status.toLowerCase() !== 'completed') {
    const steps = await stepRepo.listForTask(task.id);
    const verifs = await verificationRepo.listForTask(task.id);
    console.error('Task failed! Steps:', JSON.stringify(steps, null, 2));
    console.error('Task failed! Verifications:', JSON.stringify(verifs, null, 2));
    console.error('Task summary/status:', latestTask.summary, latestTask.status);
  }

  assert.strictEqual(
    latestTask.status.toLowerCase(),
    'completed',
    `Live LLM task must achieve COMPLETED status; current: ${latestTask.status}`
  );

  const taskBranch = `task/${task.id.slice(0, 8)}`;
  const repairedMath = await git.show([`${taskBranch}:math.js`]);
  assert.ok(
    repairedMath.includes('return a + b;'),
    'Live LLM must have fixed calculateSum to return a + b'
  );
  console.log('   ✓ Live LLM agent independently diagnosed, repaired, and proved fix in math.js.');

  // Cleanup
  try {
    await fs.rm(tmpBase, { recursive: true, force: true });
  } catch {}

  console.log('\n====================================================================');
  console.log('   LIVE LLM AUTONOMOUS REPAIR INTEGRATION TEST PASSED!              ');
  console.log('====================================================================\n');
}

runLiveLLMRepairIntegrationTest().catch((err) => {
  console.error('\n❌ Live LLM Integration Test Failure:', err);
  process.exit(1);
});
