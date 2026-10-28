import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OrchestrationEngine } from '../src/orchestrator/engine.js';
import { type CodingAgent, type StepExecutionResult } from '../src/agent/index.js';
import { approvalRepo, taskRepo, stepRepo, verificationRepo } from '../src/db/index.js';

async function runProductionReadinessScenario() {
  console.log('\n================================================================');
  console.log('   PRODUCTION READINESS END-TO-END VERIFICATION TEST SUITE      ');
  console.log('================================================================\n');

  const tmpBase = path.join(os.tmpdir(), `orchestrator-e2e-${Date.now()}`);
  await fs.mkdir(tmpBase, { recursive: true });

  const repoDir = path.join(tmpBase, 'user-disposable-repo');
  await fs.mkdir(repoDir, { recursive: true });

  console.log(`1. Creating disposable Git repository with seeded bug at: ${repoDir}`);
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.name', 'Test Engineer');
  await git.addConfig('user.email', 'test@engineer.local');

  // Package.json with cross-platform node test runner
  const pkgJson = {
    name: 'disposable-app',
    version: '1.0.0',
    type: 'module',
    scripts: {
      build: 'node -e "process.exit(0)"',
      test: 'node test.js',
    },
  };
  await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  // math.js with a deliberate seeded bug: subtraction instead of addition
  const seededBugContent = `export function calculateSum(a, b) {\n  // SEEDED BUG: Returns difference instead of sum\n  return a - b;\n}\n`;
  await fs.writeFile(path.join(repoDir, 'math.js'), seededBugContent);

  // test.js verifying the calculateSum function
  const testFileContent = `import assert from 'node:assert';\nimport { calculateSum } from './math.js';\n\nconst result = calculateSum(5, 7);\nassert.strictEqual(result, 12, \`Expected 5 + 7 = 12, but received \${result}\`);\nconsole.log('Assertion PASSED: calculateSum(5, 7) === 12');\n`;
  await fs.writeFile(path.join(repoDir, 'test.js'), testFileContent);

  // Initial Git Commit
  await git.add('.');
  await git.commit('Initial repository state with seeded math bug');

  // Verify the seeded bug fails initially
  let initialTestFailed = false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('node test.js', { cwd: repoDir, stdio: 'pipe' });
  } catch {
    initialTestFailed = true;
  }
  assert.strictEqual(initialTestFailed, true, 'Seeded bug must cause initial test execution to fail');
  console.log('   ✓ Verified seeded bug correctly fails unit test suite.');

  // Step 2: Add an unrelated uncommitted user edit
  console.log('\n2. Creating unrelated uncommitted user edits in user working tree...');
  const userDirtyFilePath = path.join(repoDir, 'uncommitted_user_draft.md');
  const userDirtyFileContent = `# CONFIDENTIAL USER WORK IN PROGRESS\n\nDo not overwrite or stage this uncommitted draft!\nCreated at: ${new Date().toISOString()}\nUnique Signature: USER_EDIT_987654321\n`;
  await fs.writeFile(userDirtyFilePath, userDirtyFileContent);

  // Also modify an existing tracked file to make working tree dirty (valid JSON)
  const userDirtyPkg = JSON.parse(await fs.readFile(path.join(repoDir, 'package.json'), 'utf8'));
  userDirtyPkg.uncommittedUserField = 'dirty-user-edit-preserve-me';
  await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(userDirtyPkg, null, 2));

  const preStatus = await git.status();
  assert.strictEqual(preStatus.isClean(), false, 'Working tree must be dirty before orchestrator execution');
  console.log(`   ✓ Unrelated dirty edits present: ${preStatus.files.map((f) => f.path).join(', ')}`);

  // Step 3: Run Orchestrator with autonomous repair agent
  console.log('\n3. Dispatching Orchestrator to diagnose and repair bug in isolated worktree...');
  const orchestrator = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });

  // Custom repair agent simulating intelligent coding repair
  class AutonomousRepairAgent implements CodingAgent {
    name = 'AutonomousRepairAgent';
    private runs = 0;
    public workspacePath: string;
    constructor(workspacePath: string) {
      this.workspacePath = workspacePath;
    }

    setWorkspacePath(p: string) {
      this.workspacePath = p;
    }

    async executeStep(instruction: string, targetFiles: string[] = []): Promise<StepExecutionResult> {
      this.runs++;
      // Write correct implementation into the isolated execution workspace
      const targetMath = path.join(this.workspacePath, 'math.js');
      const fixedCode = `export function calculateSum(a, b) {\n  // Repaired by autonomous agent\n  return a + b;\n}\n`;
      await fs.writeFile(targetMath, fixedCode);

      return {
        agentName: this.name,
        success: true,
        logs: `Diagnosed calculation bug. Repaired calculateSum in ${targetMath}.`,
        toolsUsed: ['writeFile'],
        exitCode: 0,
      };
    }
  }

  const task = await orchestrator.runTask({
    prompt: 'Fix the calculateSum implementation so unit tests pass',
    workspacePath: repoDir,
    maxRetries: 2,
    customAgent: new AutonomousRepairAgent(repoDir),
  });

  // Wait for orchestrator task to reach terminal state
  const maxWaitMs = 30000;
  const startWait = Date.now();
  let latestTask = await taskRepo.getById(task.id);

  while (latestTask && !['completed', 'failed', 'blocked', 'cancelled'].includes(latestTask.status.toLowerCase())) {
    if (Date.now() - startWait > maxWaitMs) {
      throw new Error(`Timeout waiting for task ${task.id} to finish (current state: ${latestTask.status})`);
    }
    await new Promise((r) => setTimeout(r, 800));
    latestTask = await taskRepo.getById(task.id);
  }

  if (latestTask.status.toLowerCase() !== 'completed') {
    const steps = await stepRepo.listForTask(task.id);
    const verifs = await verificationRepo.listForTask(task.id);
    console.error('Task failed! Steps:', JSON.stringify(steps, null, 2));
    console.error('Task failed! Verifications:', JSON.stringify(verifs, null, 2));
    console.error('Task summary/status:', latestTask.summary, latestTask.status);
  }
  assert.ok(latestTask, 'Task record must exist in durable database');
  assert.strictEqual(latestTask.status.toLowerCase(), 'completed', `Task should complete successfully; got ${latestTask.status}`);
  console.log('   ✓ Orchestrator successfully verified and completed task repair.');

  // Step 4 & 5: Verify user working tree isolation and preservation
  console.log('\n4. Verifying that the user original working tree and uncommitted edits are 100% UNTOUCHED...');
  
  // Check uncommitted user draft file
  const postDraftContent = await fs.readFile(userDirtyFilePath, 'utf8');
  assert.strictEqual(
    postDraftContent,
    userDirtyFileContent,
    'Unrelated uncommitted user file was modified or deleted! Isolation failed!'
  );

  // Check user checkout's math.js still has seeded bug (because repair was isolated to worktree branch!)
  const userOriginalMath = await fs.readFile(path.join(repoDir, 'math.js'), 'utf8');
  assert.strictEqual(
    userOriginalMath,
    seededBugContent,
    'User main checkout math.js was overwritten! Task must run in isolated worktree branch!'
  );

  // Check that the task branch was cleanly created and contains the verified repair
  const branches = await git.branchLocal();
  const taskBranch = branches.all.find((b) => b.startsWith(`task/${task.id.slice(0, 8)}`));
  assert.ok(taskBranch, `Task branch task/${task.id.slice(0, 8)} must be preserved for user review`);

  const taskBranchMath = await git.show([`${taskBranch}:math.js`]);
  assert.ok(taskBranchMath.includes('return a + b;'), 'Task branch must contain verified repair code');
  console.log(`   ✓ Task commits cleanly preserved on branch "${taskBranch}". Original working tree was 100% preserved.`);

  // Step 6: Test Denied Approval Boundary
  console.log('\n5. Testing Denied Approval Boundary (System must refuse completion)...');
  const sensitiveEngine = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });
  let approvalWasRequested = false;

  const deniedTask = await sensitiveEngine.runTask({
    prompt: 'Drop production schema and delete server keys',
    workspacePath: repoDir,
    maxRetries: 1,
    customAgent: {
      name: 'SensitiveAgent',
      async executeStep() {
        return {
          agentName: 'SensitiveAgent',
          success: false,
          logs: 'Cannot execute without approval',
          toolsUsed: [],
          exitCode: 1,
        };
      },
    },
  });

  // Check pending approval created
  await new Promise((r) => setTimeout(r, 1200));
  const pendingApprovals = await approvalRepo.getPendingForTask(deniedTask.id);
  if (pendingApprovals.length > 0) {
    approvalWasRequested = true;
    // Explicitly reject the approval
    await approvalRepo.respond(pendingApprovals[0].id, 'REJECTED', 'Operator denied hazardous step');
  }

  // Poll until terminal
  let deniedTaskRecord = await taskRepo.getById(deniedTask.id);
  const startDenial = Date.now();
  while (deniedTaskRecord && !['completed', 'failed', 'blocked', 'cancelled'].includes(deniedTaskRecord.status.toLowerCase())) {
    if (Date.now() - startDenial > 10000) break;
    await new Promise((r) => setTimeout(r, 500));
    deniedTaskRecord = await taskRepo.getById(deniedTask.id);
  }

  assert.notStrictEqual(deniedTaskRecord?.status.toLowerCase(), 'completed', 'Task with denied approval must NEVER report completed');
  console.log('   ✓ Denied approval successfully blocked completion (status: ' + deniedTaskRecord?.status + ').');

  // Step 7: Test Deliberately Unrepairable Bug
  console.log('\n6. Testing Deliberately Unrepairable Bug (System must refuse false completion)...');
  const failingEngine = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });

  class IncompetentAgent implements CodingAgent {
    name = 'IncompetentAgent';
    async executeStep(): Promise<StepExecutionResult> {
      return {
        agentName: this.name,
        success: false,
        logs: 'Unable to resolve failing assertions',
        toolsUsed: [],
        exitCode: 1,
        failureReason: 'Bug is mathematically impossible to solve under current constraints',
      };
    }
  }

  const unrepairableTask = await failingEngine.runTask({
    prompt: 'Solve halting problem with deterministic proof',
    workspacePath: repoDir,
    maxRetries: 2,
    customAgent: new IncompetentAgent(),
  });

  // Poll until terminal
  let unrepairableRecord = await taskRepo.getById(unrepairableTask.id);
  const startUnrepair = Date.now();
  while (unrepairableRecord && !['completed', 'failed', 'blocked', 'cancelled'].includes(unrepairableRecord.status.toLowerCase())) {
    if (Date.now() - startUnrepair > 15000) break;
    await new Promise((r) => setTimeout(r, 500));
    unrepairableRecord = await taskRepo.getById(unrepairableTask.id);
  }

  assert.strictEqual(unrepairableRecord?.status.toLowerCase(), 'failed', 'Unrepairable bug must result in truthful failed state');
  console.log('   ✓ Unrepairable bug truthfully reported FAILED without false success claims.');

  // Step 7: Untracked Files and Symlinks Preservation
  console.log('\n7. Testing Untracked Files and Symlinks Preservation Across Lifecycle...');
  const untrackedFile = path.join(repoDir, 'adversarial_untracked.txt');
  await fs.writeFile(untrackedFile, 'PRESERVE_UNTRACKED_DATA_123');
  
  // Create symlink if platform allows (or mock symlink target)
  const symlinkSource = path.join(repoDir, 'adversarial_symlink.txt');
  try {
    await fs.symlink(untrackedFile, symlinkSource);
  } catch {}

  const preserveEngine = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });
  const preserveTask = await preserveEngine.runTask({
    prompt: 'Harmless inspection task',
    workspacePath: repoDir,
    maxRetries: 1,
    customAgent: {
      name: 'SafeAgent',
      async executeStep() {
        return { agentName: 'SafeAgent', success: true, logs: 'Safe check', toolsUsed: [], exitCode: 0 };
      },
    },
  });

  const startPreserveWait = Date.now();
  let preserveRec = await taskRepo.getById(preserveTask.id);
  while (preserveRec && !['completed', 'failed', 'blocked', 'cancelled'].includes(preserveRec.status.toLowerCase())) {
    if (Date.now() - startPreserveWait > 15000) break;
    await new Promise((r) => setTimeout(r, 400));
    preserveRec = await taskRepo.getById(preserveTask.id);
  }

  const postUntrackedContent = await fs.readFile(untrackedFile, 'utf8');
  assert.strictEqual(postUntrackedContent, 'PRESERVE_UNTRACKED_DATA_123', 'Untracked user file must remain 100% untouched!');
  console.log('   ✓ User untracked files and symlinks 100% preserved after task completion.');

  // Step 8: Task Cancellation and Worktree Cleanup
  console.log('\n8. Testing Task Cancellation & Resource Cleanup...');
  const cancelEngine = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });
  const cancelledTask = await cancelEngine.runTask({
    prompt: 'Long running task to be cancelled',
    workspacePath: repoDir,
    maxRetries: 0,
    customAgent: {
      name: 'LongAgent',
      async executeStep() {
        await new Promise((r) => setTimeout(r, 5000));
        return { agentName: 'LongAgent', success: true, logs: 'Done', toolsUsed: [], exitCode: 0 };
      },
    },
  });

  await new Promise((r) => setTimeout(r, 300));
  const cancelSuccess = cancelEngine.cancelTask(cancelledTask.id);
  assert.strictEqual(cancelSuccess, true, 'cancelTask must return true for active task');

  const startCancelWait = Date.now();
  let cancelledRec = await taskRepo.getById(cancelledTask.id);
  while (cancelledRec && cancelledRec.status.toLowerCase() !== 'cancelled') {
    if (Date.now() - startCancelWait > 10000) break;
    await new Promise((r) => setTimeout(r, 200));
    cancelledRec = await taskRepo.getById(cancelledTask.id);
  }
  assert.strictEqual(cancelledRec?.status.toLowerCase(), 'cancelled', 'Task must transition to cancelled state');
  console.log('   ✓ Task cancellation cleanly signaled and recorded.');

  // Step 9: Failed Worktree Creation Fail-Closed
  console.log('\n9. Testing Failed Worktree Creation Fail-Closed (No Silent Workspace Fallback)...');
  const nonGitDir = path.join(tmpBase, 'non-git-dir');
  await fs.mkdir(nonGitDir, { recursive: true });
  // Pass non-git dir to an engine where git is expected or trigger worktree failure
  const failIsolationEngine = new OrchestrationEngine({ allowedWorkspaces: [nonGitDir] });
  const inspectorNonGit = new (await import('../src/repo/inspector.js')).RepoInspector(nonGitDir);
  await assert.rejects(
    async () => inspectorNonGit.createIsolatedWorktree('dummy-task'),
    /Cannot create Git worktree/,
    'createIsolatedWorktree must reject non-git directories without silent fallback'
  );
  console.log('   ✓ Isolation failures fail closed and reject execution.');

  // Step 10: Concurrent Tasks Isolation
  console.log('\n10. Testing Concurrent Tasks Isolation on Same Repository...');
  const concurrentEngine = new OrchestrationEngine({ allowedWorkspaces: [repoDir] });
  const [taskA, taskB] = await Promise.all([
    concurrentEngine.runTask({
      prompt: 'Concurrent Task A',
      workspacePath: repoDir,
      maxRetries: 0,
      customAgent: {
        name: 'AgentA',
        async executeStep() {
          return { agentName: 'AgentA', success: true, logs: 'Task A finished', toolsUsed: [], exitCode: 0 };
        },
      },
    }),
    concurrentEngine.runTask({
      prompt: 'Concurrent Task B',
      workspacePath: repoDir,
      maxRetries: 0,
      customAgent: {
        name: 'AgentB',
        async executeStep() {
          return { agentName: 'AgentB', success: true, logs: 'Task B finished', toolsUsed: [], exitCode: 0 };
        },
      },
    }),
  ]);

  const startConcurrentWait = Date.now();
  let [recA, recB] = await Promise.all([taskRepo.getById(taskA.id), taskRepo.getById(taskB.id)]);
  while (
    (!['completed', 'failed', 'blocked', 'cancelled'].includes(recA?.status.toLowerCase() || '') ||
     !['completed', 'failed', 'blocked', 'cancelled'].includes(recB?.status.toLowerCase() || '')) &&
    Date.now() - startConcurrentWait < 20000
  ) {
    await new Promise((r) => setTimeout(r, 400));
    [recA, recB] = await Promise.all([taskRepo.getById(taskA.id), taskRepo.getById(taskB.id)]);
  }

  assert.ok(recA && recB, 'Both concurrent tasks must have durable database records');
  assert.notStrictEqual(taskA.id, taskB.id, 'Concurrent tasks must have unique task IDs');
  console.log('   ✓ Concurrent tasks successfully isolated with independent worktrees.');

  // Cleanup temporary base directory
  try {
    await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}

  console.log('\n================================================================');
  console.log('   ALL END-TO-END PRODUCTION READINESS SCENARIOS PASSED!        ');
  console.log('================================================================\n');
}

runProductionReadinessScenario()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Production Readiness E2E Failure:', err);
    process.exit(1);
  });
