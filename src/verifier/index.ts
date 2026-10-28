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
  // Authoritative single verdict
  isVerified: boolean;
  status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
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
    customVerificationCmd?: string,
    baseCommit?: string
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
        diagnosticsList.push(`[BUILD FAILURE]: ${meta.buildCmd} failed (exit ${res.exitCode}).\n${res.stderr || res.stdout}`);
      }
    } else {
      buildCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No build command configured for repository.',
        reason: 'Missing build command.',
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
        diagnosticsList.push(`[TEST FAILURE]: ${testCmdToRun} failed (exit ${res.exitCode}).\n${res.stderr || res.stdout}`);
      }
    } else {
      testCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No test runner detected or configured.',
        reason: 'Missing test suite command.',
      };
    }

    // 3. Lint / Static Analysis Check (P0.2 FIX: Lint failures are BLOCKING)
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
        blockingReasons.push(`Static analysis / linter failed with exit code ${res.exitCode}`);
        diagnosticsList.push(`[LINT FAILURE]: ${meta.lintCmd} failed.\n${res.stderr || res.stdout}`);
      }
    } else {
      lintCheck = {
        status: 'NOT_CONFIGURED',
        output: 'No linter configured.',
      };
    }

    // 4. Git Diff Audit (P1.1 FIX: Diff against baseline commit, including committed checkpoint changes)
    let diff = '';
    if (baseCommit && baseCommit !== 'initial') {
      try {
        const git = (this.inspector as any).git;
        diff = await git.diff([baseCommit]);
      } catch {
        diff = await this.inspector.getDiff();
      }
    } else {
      diff = await this.inspector.getDiffAgainstBase();
    }

    const gitStatus = await this.inspector.getGitStatus();
    const filesChanged = gitStatus ? gitStatus.files.map((f) => f.path) : [];

    // P1 FIX: Inspect entire cumulative commit history from baseCommit, not just working tree
    const allFilesChangedSet = new Set<string>(filesChanged);
    if (baseCommit && baseCommit !== 'initial') {
      try {
        const git = (this.inspector as any).git;
        const nameOnly: string = await git.diff(['--name-only', baseCommit, 'HEAD']);
        for (const line of nameOnly.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) allFilesChangedSet.add(trimmed);
        }
      } catch {}
    }
    // Parse filenames from diff headers as well
    const diffFileMatches = diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
    for (const match of diffFileMatches) {
      if (match[2]) allFilesChangedSet.add(match[2].trim());
    }
    const allCumulativeFiles = Array.from(allFilesChangedSet);

    let hasSuspiciousDeletions = false;
    let hasForbiddenModifications = false;
    let hasPlaceholderStubs = false;
    const diffNotes: string[] = [];

    // Security check for sensitive secret files across ALL cumulative changes
    for (const f of allCumulativeFiles) {
      const lower = f.toLowerCase();
      if (
        lower.includes('.env') ||
        lower.includes('credentials') ||
        lower.includes('id_rsa') ||
        lower.includes('.pem') ||
        lower.includes('.key')
      ) {
        hasForbiddenModifications = true;
        diffNotes.push(`Sensitive secret file modified in task history: ${f}`);
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

    // Placeholder Stubs Detection
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
    // P0.2 & P1 FIX: Meaningful criteria verification; diff alone cannot prove functional implementation!
    if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
      blockingReasons.push('No acceptance criteria specified for task verification.');
    } else {
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
        } else if (lower.includes('file presence') || lower.includes('create file') || lower.includes('add file')) {
          checkType = 'file_presence';
          satisfied = allCumulativeFiles.length > 0;
          evidence = `Observed modified/created files: ${allCumulativeFiles.join(', ') || 'None'}`;
        } else {
          // P1 FIX: Genuinely semantic criteria verification.
          // A general passing test suite does NOT prove a specific feature requirement without targeted evidence!
          checkType = 'diff';
          const hasChanges = allCumulativeFiles.length > 0 || Boolean(diff && diff.length > 0);
          const testsPassed = testCheck.status === 'PASSED';

          if (!hasChanges) {
            satisfied = false;
            evidence = 'No code changes detected in repository diff to satisfy criterion.';
          } else if (testCheck.status === 'FAILED') {
            satisfied = false;
            evidence = `Automated tests failed (exit code ${testCheck.exitCode ?? 1}) - implementation behavior not verified.`;
          } else if (testCheck.status === 'NOT_CONFIGURED') {
            satisfied = false;
            evidence = `Unverified: No automated test suite or verification command was configured to prove "${criterion}".`;
          } else if (testsPassed && !hasSuspiciousDeletions && !hasPlaceholderStubs) {
            // Extract core semantic keywords for the criterion
            const semanticKeywords = lower
              .replace(/[^a-z0-9\s]/g, ' ')
              .split(/\s+/)
              .filter(
                (w) =>
                  w.length > 2 &&
                  ![
                    'must',
                    'should',
                    'with',
                    'that',
                    'this',
                    'have',
                    'from',
                    'when',
                    'then',
                    'unit',
                    'test',
                    'tests',
                    'pass',
                    'code',
                    'implement',
                    'implementation',
                    'correctly',
                    'properly',
                    'feature',
                    'logic',
                    'functional',
                    'requirement',
                    'requirements',
                    'requested',
                    'fulfills',
                    'fulfill',
                    'meets',
                    'verified',
                    'satisfies',
                    'passes',
                    'check',
                    'checks',
                    'for',
                    'are',
                  ].includes(w)
              );

            const hasTargetedCommand = Boolean(
              customVerificationCmd && semanticKeywords.some((kw) => customVerificationCmd.toLowerCase().includes(kw))
            );
            const hasTargetedTestOutput = semanticKeywords.some((kw) =>
              testCheck.output.toLowerCase().includes(kw)
            );
            const hasTargetedTestInDiff =
              allCumulativeFiles.some((f) => /test|spec/i.test(f)) &&
              semanticKeywords.some((kw) => diff.toLowerCase().includes(kw));

            if (hasTargetedCommand || hasTargetedTestOutput || hasTargetedTestInDiff) {
              satisfied = true;
              evidence = `Verified with targeted test evidence: ${
                hasTargetedCommand
                  ? `custom command "${customVerificationCmd}"`
                  : hasTargetedTestInDiff
                  ? `test suite in diff targeted to [${semanticKeywords.join(', ')}]`
                  : `test output confirmed assertions for [${semanticKeywords.join(', ')}]`
              }.`;
            } else {
              satisfied = false;
              evidence = `Unverified semantic criterion: General test suite passed, but no targeted test assertion in test output or diff verifies requirement: "${criterion}".`;
            }
          } else {
            satisfied = false;
            evidence = `Verification incomplete for "${criterion}".`;
          }
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
    }

    // Authoritative Unified Verdict
    const hasActiveFailures =
      buildCheck.status === 'FAILED' ||
      testCheck.status === 'FAILED' ||
      lintCheck.status === 'FAILED' ||
      hasForbiddenModifications ||
      hasSuspiciousDeletions;

    let status: VerificationReport['status'];
    if (hasActiveFailures || blockingReasons.length > 0) {
      status = 'FAILED';
    } else if (
      buildCheck.status === 'NOT_CONFIGURED' &&
      testCheck.status === 'NOT_CONFIGURED' &&
      filesChanged.length === 0 &&
      diff.length === 0
    ) {
      status = 'INCONCLUSIVE';
      blockingReasons.push('Inconclusive verification: No verification commands configured and no files modified.');
    } else {
      status = 'PASSED';
    }

    const isVerified = status === 'PASSED';

    return {
      isVerified,
      status,
      buildCheck,
      testCheck,
      lintCheck,
      criteriaResults,
      diffAudit: {
        filesChanged,
        hasSuspiciousDeletions,
        hasForbiddenModifications,
        hasPlaceholderStubs,
        summary: diffNotes.length > 0 ? diffNotes.join('; ') : `Audited ${filesChanged.length} changed files cleanly.`,
      },
      diagnostics: diagnosticsList.join('\n\n'),
      blockingReasons,
    };
  }
}
