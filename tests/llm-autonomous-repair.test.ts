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

  const isLlmRequired = process.env.REQUIRE_LLM === 'true';
  if (!config.geminiApiKey) {
    if (isLlmRequired) {
      console.error('\n❌ [ERROR] GEMINI_API_KEY is required because REQUIRE_LLM=true, but no key was configured.');
      process.exit(1);
    }
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

  const steps = await stepRepo.listForTask(task.id);
  const verifs = await verificationRepo.listForTask(task.id);

  if (latestTask.status.toLowerCase() !== 'completed') {
    console.error('Task failed! Steps:', JSON.stringify(steps, null, 2));
    console.error('Task failed! Verifications:', JSON.stringify(verifs, null, 2));
    console.error('Task summary/status:', latestTask.summary, latestTask.status);
  }

  // 4a. Genuinely verified terminal state
  assert.strictEqual(
    latestTask.status.toLowerCase(),
    'completed',
    `Live LLM task must achieve COMPLETED status; current: ${latestTask.status}`
  );
  
  // Find the final relevant verification record for this task
  const taskVerifs = verifs.filter((v) => v.taskId === task.id);
  assert.ok(taskVerifs.length > 0, 'Task must have produced verification records');
  const sortedVerifs = [...taskVerifs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const finalVerif = sortedVerifs[sortedVerifs.length - 1];
  assert.strictEqual(
    finalVerif.status,
    'PASSED',
    `Final verification status must be PASSED; got ${finalVerif.status}`
  );
  assert.strictEqual(
    finalVerif.testStatus,
    'PASSED',
    `Final testStatus must be PASSED; got ${finalVerif.testStatus}`
  );

  // 4b. Primary acceptance criterion: target repository test suite passes on the task branch
  const taskBranch = `task/${task.id.slice(0, 8)}`;
  await git.checkout(taskBranch);

  const { execSync } = await import('node:child_process');
  let testSuiteOutput = '';
  try {
    testSuiteOutput = execSync('node test.js', { cwd: repoDir, encoding: 'utf-8' });
  } catch (err: any) {
    assert.fail(`Seeded test suite failed on repaired branch "${taskBranch}": ${err.stdout || err.message}`);
  }
  assert.ok(
    testSuiteOutput.includes('Unit tests passed'),
    `Seeded test suite must pass cleanly; got: ${testSuiteOutput}`
  );

  // 4c. Semantic git diff inspection (evaluates additions and deletions separately)
  const diff = await git.diff(['HEAD~1', 'HEAD', '--', 'math.js']);
  assert.ok(diff.includes('--- a/math.js') && diff.includes('+++ b/math.js'), 'Diff must touch math.js');

  const diffLines = diff.split('\n');
  const deletedLines = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const addedLines = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));

  assert.ok(
    deletedLines.some((l) => l.includes('return a - b;')),
    'Git diff deletions must include the buggy line (- return a - b;)'
  );
  assert.ok(
    !addedLines.some((l) => l.includes('return a - b;')),
    'Git diff additions must not reintroduce the buggy line'
  );
  assert.ok(
    addedLines.length > 0,
    'Git diff additions must introduce the repaired implementation'
  );

  // Confirm repaired file on disk no longer contains the buggy logic
  const repairedMathOnDisk = await fs.readFile(path.join(repoDir, 'math.js'), 'utf-8');
  assert.ok(
    !repairedMathOnDisk.includes('return a - b;'),
    'Repaired math.js must not contain the buggy return statement'
  );

  console.log('   ✓ Seeded test suite cleanly passed on task branch.');
  console.log('   ✓ Semantic diff verified: buggy deletion and valid repair addition verified.');
  console.log('   ✓ Task reached genuinely verified completed terminal state with status: PASSED.');

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
