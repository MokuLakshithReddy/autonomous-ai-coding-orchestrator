import { AgentToolbox, type CommandResult } from '../agent/tools.js';
import { RepoInspector, type ProjectMetadata } from '../repo/inspector.js';

export type CheckStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED' | 'NOT_RUN' | 'INCONCLUSIVE';

export interface VerificationCheckResult {
  status: CheckStatus;
  command?: string;
  output: string;
  exitCode?: number;
  durationMs?: number;
  reason?: string;
}

export interface CriterionVerification {
  criterion: string;
  satisfied: boolean;
  evidence: string;
  checkType: 'build' | 'test' | 'diff' | 'file_presence' | 'static_analysis';
}

export interface VerificationReport {
  overallPassed: boolean;
  canDeclareComplete: boolean;
  buildCheck: VerificationCheckResult;
  testCheck: VerificationCheckResult;
  lintCheck: VerificationCheckResult;
  criteriaResults: CriterionVerification[];
  diffAudit: {
    filesChanged: string[];
    hasSuspiciousDeletions: boolean;
    hasForbiddenModifications: boolean;
    hasPlaceholderStubs: boolean;
    summary: string;
  };
  diagnostics: string;
  blockingReasons: string[];
}

export class IndependentVerifier {
  private workspacePath: string;
  private toolbox: AgentToolbox;
  private inspector: RepoInspector;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.toolbox = new AgentToolbox(workspacePath);
    this.inspector = new RepoInspector(workspacePath);
  }

  async verify(
    meta: ProjectMetadata,
    acceptanceCriteria: string[] = [],
    customVerificationCmd?: string
  ): Promise<VerificationReport> {
    const blockingReasons: string[] = [];
    const diagnosticsList: string[] = [];
    const criteriaResults: CriterionVerification[] = [];

    // 1. Build Verification
    let buildCheck: VerificationCheckResult;
    if (meta.buildCmd) {
      const res = await this.toolbox.executeCommand(meta.buildCmd, 120000);
      const passed = res.exitCode === 0;
      buildCheck = {
        status: passed ? 'PASSED' : 'FAILED',
        command: meta.buildCmd,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
        durationMs: res.durationMs,
      };
      if (!passed) {
        blockingReasons.push(`Build failed with exit code ${res.exitCode}`);
        diagnosticsList.push(`[BUILD FAILURE]: ${meta.buildCmd} failed.\n${res.stderr || res.stdout}`);
      }
    } else {
      // Truthful: If no build command is configured, state NOT_CONFIGURED, do not pretend it passed!
      buildCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No build command configured for repository.',
        reason: 'Project ecosystem does not declare a compilation build script.',
      };
    }

    // 2. Test Suite Verification
    let testCheck: VerificationCheckResult;
    const testCmdToRun = customVerificationCmd || meta.testCmd;
    if (testCmdToRun) {
      const res = await this.toolbox.executeCommand(testCmdToRun, 180000);
      const passed = res.exitCode === 0;
      testCheck = {
        status: passed ? 'PASSED' : 'FAILED',
        command: testCmdToRun,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
        durationMs: res.durationMs,
      };
      if (!passed) {
        blockingReasons.push(`Automated test suite failed with exit code ${res.exitCode}`);
        diagnosticsList.push(`[TEST FAILURE]: ${testCmdToRun} failed.\n${res.stderr || res.stdout}`);
      }
    } else {
      // Truthful: Missing test command is NOT_CONFIGURED / NOT_RUN, never "passed"!
      testCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No test runner detected or configured.',
        reason: 'Missing test suite command. Tasks requiring test validation cannot pass this check.',
      };
    }

    // 3. Lint / Static Analysis Check
    let lintCheck: VerificationCheckResult;
    if (meta.lintCmd && buildCheck.status !== 'FAILED') {
      const res = await this.toolbox.executeCommand(meta.lintCmd, 60000);
      const passed = res.exitCode === 0;
      lintCheck = {
        status: passed ? 'PASSED' : 'FAILED',
        command: meta.lintCmd,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
        durationMs: res.durationMs,
      };
      if (!passed) {
        diagnosticsList.push(`[LINT WARNING]: ${meta.lintCmd} flagged code style or lint issues.`);
      }
    } else {
      lintCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No linter configured.',
      };
    }

    // 4. Git Diff & Anti-Tampering Audit
    const diff = await this.inspector.getDiff();
    const gitStatus = await this.inspector.getGitStatus();
    const filesChanged = gitStatus ? gitStatus.files.map((f) => f.path) : [];

    let hasSuspiciousDeletions = false;
    let hasForbiddenModifications = false;
    let hasPlaceholderStubs = false;
    const diffNotes: string[] = [];

    // Check for sensitive files
    for (const f of filesChanged) {
      const lower = f.toLowerCase();
      if (lower.includes('.env') || lower.includes('credentials') || lower.includes('id_rsa') || lower.includes('.pem')) {
        hasForbiddenModifications = true;
        diffNotes.push(`Sensitive secret file modified: ${f}`);
        blockingReasons.push(`Unauthorized modification of sensitive secret file: ${f}`);
      }
    }

    // Anti-Tamper Check: Detect suspicious test bypassing / skipping inserted into diff
    if (
      diff.includes('test.skip') ||
      diff.includes('it.skip') ||
      diff.includes('describe.skip') ||
      diff.includes('@pytest.mark.skip')
    ) {
      hasSuspiciousDeletions = true;
      diffNotes.push('Anti-Tamper Warning: Suspicious test-skipping statements detected in diff.');
      blockingReasons.push('Test assertions were bypassed or marked skipped in diff.');
    }

    // Placeholder Stubs Detection: Detect empty stubs or "TODO: implement" in modified files
    if (
      /\/\/\s*TODO:\s*implement/i.test(diff) ||
      /#\s*TODO:\s*implement/i.test(diff) ||
      /\bthrow new NotImplementedError\b/i.test(diff) ||
      /\bpass\s*#\s*todo\b/i.test(diff)
    ) {
      hasPlaceholderStubs = true;
      diffNotes.push('Placeholder stub or unimplemented function found in diff.');
      blockingReasons.push('Implementation contains unfulfilled placeholder stubs or TODOs.');
    }

    // 5. Explicit Acceptance Criteria Verification
    for (const criterion of acceptanceCriteria) {
      const lower = criterion.toLowerCase();
      let satisfied = false;
      let evidence = '';
      let checkType: CriterionVerification['checkType'] = 'diff';

      if (lower.includes('build') || lower.includes('compil')) {
        checkType = 'build';
        satisfied = buildCheck.status === 'PASSED';
        evidence = `Build status: ${buildCheck.status} (exit ${buildCheck.exitCode ?? 'N/A'})`;
      } else if (lower.includes('test') || lower.includes('spec') || lower.includes('unit')) {
        checkType = 'test';
        satisfied = testCheck.status === 'PASSED';
        evidence = `Test status: ${testCheck.status} (exit ${testCheck.exitCode ?? 'N/A'})`;
      } else if (lower.includes('file') || lower.includes('creat') || lower.includes('implement')) {
        checkType = 'file_presence';
        // Verify files were actually changed or created on disk
        satisfied = filesChanged.length > 0;
        evidence = `Observed modified files: ${filesChanged.join(', ') || 'None'}`;
      } else {
        checkType = 'diff';
        satisfied = filesChanged.length > 0 && !hasSuspiciousDeletions && !hasPlaceholderStubs;
        evidence = `Verified diff modified ${filesChanged.length} files without suspicious bypasses.`;
      }

      criteriaResults.push({
        criterion,
        satisfied,
        evidence,
        checkType,
      });

      if (!satisfied) {
        blockingReasons.push(`Acceptance criterion not verified: "${criterion}" (${evidence})`);
      }
    }

    // Determine Truthful Overall Verdict
    // A task can only declare completion if NO blocking reasons exist AND at least one positive proof of implementation exists
    const hasActiveFailures = buildCheck.status === 'FAILED' || testCheck.status === 'FAILED';
    const overallPassed = !hasActiveFailures && !hasForbiddenModifications && !hasSuspiciousDeletions;
    const canDeclareComplete = overallPassed && blockingReasons.length === 0;

    return {
      overallPassed,
      canDeclareComplete,
      buildCheck,
      testCheck,
      lintCheck,
      criteriaResults,
      diffAudit: {
        filesChanged,
        hasSuspiciousDeletions,
        hasForbiddenModifications,
        hasPlaceholderStubs,
        summary: diffNotes.length > 0 ? diffNotes.join('; ') : `Changed ${filesChanged.length} files cleanly.`,
      },
      diagnostics: diagnosticsList.join('\n\n'),
      blockingReasons,
    };
  }
}
