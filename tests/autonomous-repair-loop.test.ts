import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OrchestrationEngine } from '../src/orchestrator/engine.js';
import { BuiltInAutonomousAgent, type GenAIClient } from '../src/agent/index.js';
import { taskRepo, stepRepo, verificationRepo, initDatabase } from '../src/db/index.js';

async function runAutonomousRepairLoopTest() {
  console.log('\n================================================================');
  console.log('   AUTONOMOUS REPAIR LOOP WITH BUILT-IN AGENT INTEGRATION TEST   ');
  console.log('================================================================\n');

  await initDatabase();

  // 1. Create a disposable Git repository with a seeded calculation bug
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-built-in-agent-'));
  const repoDir = path.join(tmpBase, 'test-repo');
  await fs.mkdir(repoDir, { recursive: true });

  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.name', 'Autonomous Agent Test');
  await git.addConfig('user.email', 'agent-test@orchestrator.local');

  const pkgJson = {
    name: 'test-repo-repair-loop',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node test.js',
    },
  };
  await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // Seeded bug: subtraction instead of addition
  const buggyMath = `export function calculateSum(a, b) {\n  return a - b;\n}\n`;
  await fs.writeFile(path.join(repoDir, 'math.js'), buggyMath);

  const testFile = `import assert from 'node:assert';
import { calculateSum } from './math.js';

try {
  const result = calculateSum(2, 3);
  assert.strictEqual(result, 5, \`Expected 5 but got \${result}\`);
  console.log('Math tests passed!');
  process.exit(0);
} catch (err) {
  console.error('Test failed:', err.message);
  process.exit(1);
}
`;
  await fs.writeFile(path.join(repoDir, 'test.js'), testFile);

  await git.add('.');
  await git.commit('Initial commit with seeded calculation bug');

  console.log('1. Created disposable repository with seeded bug at:', repoDir);

  // 2. Configure a controlled model client for the BuiltInAutonomousAgent
  // Simulates realistic multi-turn agent behavior:
  // Turn 1: Run tests to observe failure
  // Turn 2: Write repaired implementation based on failure output
  // Turn 3: Run tests to verify the repair
  // Turn 4: Declare step complete
  let turn = 0;
  const turnsExecuted: string[] = [];

  const controlledModelClient: GenAIClient = {
    models: {
      async generateContent(params) {
        turn++;
        if (turn === 1) {
          turnsExecuted.push('executeCommand:node test.js (investigate failure)');
          return {
            text: JSON.stringify({
              thought: 'I will first run node test.js to diagnose the failing test suite and observe the failure message.',
              action: 'executeCommand',
              command: 'node test.js',
              summary: 'Run test suite to observe failure',
            }),
          };
        } else if (turn === 2) {
          turnsExecuted.push('writeFile:math.js (apply repaired code)');
          return {
            text: JSON.stringify({
              thought: 'The test failed because calculateSum performed subtraction instead of addition. I will fix math.js to return a + b.',
              action: 'writeFile',
              filePath: 'math.js',
              fileContent: 'export function calculateSum(a, b) {\n  return a + b;\n}\n',
              summary: 'Repair calculateSum to perform addition',
            }),
          };
        } else if (turn === 3) {
          turnsExecuted.push('executeCommand:node test.js (verify fix)');
          return {
            text: JSON.stringify({
              thought: 'Now I will run node test.js again to verify that my repair made the unit tests pass.',
              action: 'executeCommand',
              command: 'node test.js',
              summary: 'Verify unit tests pass with repair',
            }),
          };
        } else {
          turnsExecuted.push('complete');
          return {
            text: JSON.stringify({
              thought: 'The unit tests passed cleanly. I will declare this implementation step complete.',
              action: 'complete',
              summary: 'Repaired calculateSum implementation and verified tests pass.',
            }),
          };
        }
      },
    },
  };

  const builtInAgent = new BuiltInAutonomousAgent(
    repoDir,
    async () => true,
    controlledModelClient
  );

  console.log('2. Instantiated BuiltInAutonomousAgent with controlled model configuration.');

  // 3. Dispatch task via OrchestrationEngine
  console.log('3. Running task through OrchestrationEngine with BuiltInAutonomousAgent...');
  const orchestrator = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });

  const task = await orchestrator.runTask({
    prompt: 'Fix the calculateSum function in math.js so that node test.js passes',
    workspacePath: repoDir,
    maxRetries: 2,
    customAgent: builtInAgent,
  });

  // Wait for orchestrator task to finish
  const maxWaitMs = 30000;
  const startWait = Date.now();
  let latestTask = await taskRepo.getById(task.id);

  while (latestTask && !['completed', 'failed', 'blocked', 'cancelled'].includes(latestTask.status.toLowerCase())) {
    if (Date.now() - startWait > maxWaitMs) {
      throw new Error(`Timeout waiting for task ${task.id} to finish (current state: ${latestTask.status})`);
    }
    await new Promise((r) => setTimeout(r, 600));
    latestTask = await taskRepo.getById(task.id);
  }

  // 4. Assert full autonomous repair loop was completed and verified
  console.log('\n4. Verifying autonomous repair loop execution metrics...');
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
    `Task should reach COMPLETED status; current: ${latestTask.status}`
  );

  assert.ok(
    turnsExecuted.length >= 4,
    `Built-in agent must have executed at least 4 turns, got ${turnsExecuted.length}`
  );
  assert.ok(
    turnsExecuted.includes('executeCommand:node test.js (investigate failure)'),
    'Agent must have investigated failure with command execution'
  );
  assert.ok(
    turnsExecuted.includes('writeFile:math.js (apply repaired code)'),
    'Agent must have applied repair with writeFile tool'
  );
  assert.ok(
    turnsExecuted.includes('complete'),
    'Agent must have cleanly completed the loop'
  );
  console.log('   ✓ BuiltInAutonomousAgent successfully diagnosed failure, applied fix, verified tests, and declared completion.');

  // 5. Verify task branch and git preservation
  console.log('\n5. Verifying git task branch and commit preservation...');
  const taskBranch = `task/${task.id.slice(0, 8)}`;
  const branches = await git.branchLocal();
  assert.ok(
    branches.all.includes(taskBranch),
    `Task branch "${taskBranch}" must be preserved in the repository`
  );

  const repairedMathContent = await git.show([`${taskBranch}:math.js`]);
  assert.ok(
    repairedMathContent.includes('return a + b;'),
    'Repaired file on task branch must contain verified fix'
  );
  console.log(`   ✓ Task branch "${taskBranch}" contains verified code changes.`);

  // Cleanup disposable directory
  try {
    await fs.rm(tmpBase, { recursive: true, force: true });
  } catch {}

  console.log('\n================================================================');
  console.log('   AUTONOMOUS REPAIR LOOP WITH BUILT-IN AGENT PASSED!           ');
  console.log('================================================================\n');
}

runAutonomousRepairLoopTest().catch((err) => {
  console.error('\n❌ Autonomous Repair Loop Test Failure:', err);
  process.exit(1);
});
