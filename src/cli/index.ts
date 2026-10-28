import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { orchestrator, type OrchestratorEvent } from '../orchestrator/engine.js';
import { initDatabase, taskRepo } from '../db/index.js';
import { RepoInspector } from '../repo/inspector.js';
import { SecurityPolicyEngine } from '../security/policy.js';
import { config } from '../config/index.js';

const program = new Command();

program
  .name('orchestrator')
  .description('Autonomous AI Coding Orchestrator — Closed-Loop Planning, Execution & Verification')
  .version('1.0.0');

program
  .command('serve')
  .description('Start the Orchestrator API & WebSocket server')
  .option('-p, --port <number>', 'Port to listen on', String(config.port))
  .option('-h, --host <string>', 'Host to bind to', config.host)
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const host = opts.host;
    console.log(chalk.bold.cyan('\n🚀 Launching Autonomous AI Coding Orchestrator Server...'));

    const server = await createServer();
    try {
      const address = await server.listen({ port, host });
      console.log(chalk.green(`\n✓ Server listening at: ${chalk.bold(address)}`));
      console.log(chalk.blue(`✓ Realtime WebSocket: ${chalk.bold(`ws://${host}:${port}/ws`)}`));
      console.log(chalk.yellow(`✓ API Endpoints active at /api/tasks, /api/repo/inspect, /api/system/status\n`));
    } catch (err: any) {
      console.error(chalk.red('Failed to start server:'), err);
      process.exit(1);
    }
  });

program
  .command('run')
  .description('Execute an autonomous coding task in the specified workspace')
  .requiredOption('-p, --prompt <string>', 'User coding requirement or task objective')
  .option('-w, --workspace <path>', 'Target repository workspace path', '.')
  .option('-r, --retries <number>', 'Maximum self-repair retry budget', String(config.maxRetryBudget))
  .action(async (opts) => {
    await initDatabase();
    const allowedRoots =
      config.allowedWorkspaces.length > 0
        ? config.allowedWorkspaces
        : (config.allowUnrestrictedWorkspaces ? [] : [process.cwd()]);
    const authorizedWorkspace = SecurityPolicyEngine.validateWorkspaceAuthorization(
      opts.workspace,
      allowedRoots,
      { allowUnrestricted: config.allowUnrestrictedWorkspaces }
    );
    const resolvedWorkspace = SecurityPolicyEngine.assertPathContainment(authorizedWorkspace, authorizedWorkspace);
    const maxRetries = parseInt(opts.retries, 10);

    console.log(chalk.bold.magenta('\n======================================================'));
    console.log(chalk.bold.magenta('      AUTONOMOUS AI CODING ORCHESTRATOR               '));
    console.log(chalk.bold.magenta('======================================================\n'));
    console.log(chalk.white(`Workspace:  ${chalk.cyan(resolvedWorkspace)}`));
    console.log(chalk.white(`Objective:  ${chalk.yellow(opts.prompt)}`));
    console.log(chalk.white(`Max Retries: ${chalk.green(maxRetries)}\n`));

    // Listen to real-time events and format for terminal
    orchestrator.on('event', (e: OrchestratorEvent) => {
      const time = chalk.gray(`[${e.timestamp.slice(11, 19)}]`);
      switch (e.type) {
        case 'TASK_CREATED':
          console.log(`${time} ${chalk.bold.blue('⚡ TASK INITIALIZED:')} ${e.message}`);
          break;
        case 'REPO_INSPECTED':
          console.log(`${time} ${chalk.cyan('🔍 REPO INSPECTED:')} ${e.message}`);
          break;
        case 'PLAN_GENERATED':
          console.log(`${time} ${chalk.magenta('📋 PLAN FORMULATED:')} ${e.message}`);
          if (e.data?.acceptanceCriteria) {
            console.log(chalk.bold('   Acceptance Criteria:'));
            for (const c of e.data.acceptanceCriteria) {
              console.log(chalk.gray(`     • ${c}`));
            }
          }
          break;
        case 'STEP_STARTED':
          console.log(`\n${time} ${chalk.bold.yellow('▶ STEP START:')} ${e.message}`);
          break;
        case 'STEP_EXECUTED':
          console.log(`${time} ${chalk.green('✓ AGENT FINISHED:')} ${e.message}`);
          break;
        case 'STEP_VERIFYING':
          console.log(`${time} ${chalk.cyan('🛡 INDEPENDENT VERIFICATION:')} ${e.message}`);
          break;
        case 'VERIFICATION_PASSED':
          console.log(`${time} ${chalk.bold.green('✔ VERIFICATION PASSED:')} ${e.message}`);
          break;
        case 'VERIFICATION_FAILED':
          console.log(`${time} ${chalk.bold.red('✖ VERIFICATION FAILED:')} ${e.message}`);
          break;
        case 'DIAGNOSING_ERROR':
          console.log(`${time} ${chalk.yellow('🧠 LLM RCA DIAGNOSIS:')} ${e.message}`);
          break;
        case 'REPAIR_ATTEMPT':
          console.log(`${time} ${chalk.bold.magenta('🔧 SELF-REPAIR ATTEMPT:')} ${e.message}`);
          break;
        case 'TASK_COMPLETED':
          console.log(`\n${time} ${chalk.bold.green('🎉 MISSION COMPLETE:')} ${e.message}\n`);
          process.exit(0);
          break;
        case 'TASK_PARTIALLY_COMPLETED':
          console.log(`\n${time} ${chalk.bold.yellow('⚠️ TASK PARTIALLY COMPLETED:')} ${e.message}\n`);
          process.exit(2);
          break;
        case 'TASK_NEEDS_REVIEW':
          console.log(`\n${time} ${chalk.bold.blue('👀 TASK REQUIRES HUMAN REVIEW:')} ${e.message}\n`);
          process.exit(3);
          break;
        case 'TASK_FAILED':
          console.log(`\n${time} ${chalk.bold.red('❌ MISSION FAILED:')} ${e.message}\n`);
          process.exit(1);
          break;
        case 'TASK_BLOCKED':
          console.log(`\n${time} ${chalk.bold.red('⛔ TASK BLOCKED:')} ${e.message}\n`);
          process.exit(1);
          break;
        case 'APPROVAL_REQUIRED':
          console.log(`\n${time} ${chalk.bold.yellow('🔒 APPROVAL REQUIRED:')} ${e.message}`);
          console.log(chalk.yellow(`   Review and approve via Web Dashboard or API: POST /api/approvals/${e.data?.approvalId}/respond`));
          break;
      }
    });

    try {
      await orchestrator.runTask({
        prompt: opts.prompt,
        workspacePath: resolvedWorkspace,
        maxRetries,
      });
    } catch (err: any) {
      console.error(chalk.red('Fatal orchestrator failure:'), err);
      process.exit(1);
    }
  });

program
  .command('inspect')
  .description('Inspect repository and detect project ecosystem and verification commands')
  .option('-w, --workspace <path>', 'Workspace directory to inspect', '.')
  .action(async (opts) => {
    const resolved = path.resolve(opts.workspace);
    const inspector = new RepoInspector(resolved);
    const meta = await inspector.inspect();
    console.log(chalk.bold.cyan(`\nRepository Inspection for: ${resolved}\n`));
    console.log(chalk.white(`Git Repository:     ${meta.isGitRepo ? chalk.green('Yes') : chalk.gray('No')}`));
    console.log(chalk.white(`Active Branch:      ${chalk.yellow(meta.branch || 'None')}`));
    console.log(chalk.white(`Latest Commit:      ${chalk.gray(meta.latestCommit?.slice(0, 7) || 'None')}`));
    console.log(chalk.white(`Uncommitted Files:  ${meta.uncommittedFiles.length ? chalk.red(meta.uncommittedFiles.join(', ')) : chalk.green('Clean')}`));
    console.log(chalk.white(`Ecosystems:         ${chalk.magenta(meta.ecosystems.join(', '))}`));
    console.log(chalk.white(`Package Manager:    ${chalk.cyan(meta.packageManager || 'None')}`));
    console.log(chalk.white(`Build Command:      ${chalk.yellow(meta.buildCmd || 'None')}`));
    console.log(chalk.white(`Test Command:       ${chalk.yellow(meta.testCmd || 'None')}`));
    console.log(chalk.white(`Lint Command:       ${chalk.yellow(meta.lintCmd || 'None')}\n`));
  });

program.parse(process.argv);
