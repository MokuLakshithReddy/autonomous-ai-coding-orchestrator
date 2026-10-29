import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentToolbox, type CommandResult } from '../agent/tools.js';
import { RepoInspector, type ProjectMetadata } from '../repo/inspector.js';
import { SecurityPolicyEngine } from '../security/policy.js';

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
  checkType: 'build' | 'test' | 'diff' | 'file_presence' | 'static_analysis' | 'targeted_check';
  targetCommand?: string;
  exitCode?: number;
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
    baseCommit?: string,
    options?: { isIntermediateStep?: boolean; abortSignal?: AbortSignal }
  ): Promise<VerificationReport> {
    const blockingReasons: string[] = [];
    const diagnosticsList: string[] = [];
    const criteriaResults: CriterionVerification[] = [];

    // 1. Build Verification
    let buildCheck: VerificationCheckResult;
    if (meta.buildCmd) {
      const res = await this.toolbox.executeCommand(meta.buildCmd, 120000, {}, options?.abortSignal);
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
      const res = await this.toolbox.executeCommand(testCmdToRun, 180000, {}, options?.abortSignal);
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
      const res = await this.toolbox.executeCommand(meta.lintCmd, 60000, {}, options?.abortSignal);
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
      } catch { }
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
      // Allow harmless example / template / distribution files
      if (
        lower.endsWith('.example') ||
        lower.endsWith('.sample') ||
        lower.endsWith('.template') ||
        lower.endsWith('.dist')
      ) {
        continue;
      }
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

    // Anti-Tamper & Content Check: Inspect added and deleted lines across diff
    const addedTestLines: string[] = [];
    const addedPackageJsonLines: string[] = [];
    const addedAllLines: string[] = [];
    const deletedTestLines: string[] = [];
    let deletedAssertionCount = 0;
    let addedAssertionCount = 0;
    let currentDiffFile = '';

    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+?)$/);
        currentDiffFile = match ? match[2].trim() : '';
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        const added = line.slice(1);
        addedAllLines.push(added);
        if (/(\.test\.|\.spec\.|(^|[\\/])tests?(\.|\/)|(^|[\\/])test_[a-z0-9_]+\.py)/i.test(currentDiffFile)) {
          addedTestLines.push(added);
          if (/\b(assert|expect|test|it)\s*[\.(]/i.test(added)) {
            addedAssertionCount++;
          }
        }
        if (currentDiffFile.endsWith('package.json')) {
          addedPackageJsonLines.push(added);
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const deleted = line.slice(1);
        if (/(\.test\.|\.spec\.|(^|[\\/])tests?(\.|\/)|(^|[\\/])test_[a-z0-9_]+\.py)/i.test(currentDiffFile)) {
          deletedTestLines.push(deleted);
          if (/\b(assert|expect|test|it)\s*[\.(]/i.test(deleted)) {
            deletedAssertionCount++;
          }
        }
      }
    }

    // Anti-Tamper Check: Detect suspicious test bypassing / skipping inserted into test files
    const testDiffContent = addedTestLines.join('\n');
    if (
      /\b(test\.skip|it\.skip|describe\.skip|xit|xdescribe)\s*\(/i.test(testDiffContent) ||
      /@pytest\.mark\.skip/i.test(testDiffContent)
    ) {
      hasSuspiciousDeletions = true;
      diffNotes.push('Anti-Tamper Warning: Suspicious test-skipping statements detected in test diff.');
      blockingReasons.push('Test assertions were bypassed or marked skipped in diff.');
    }

    // Anti-Tamper Check: Detect suspicious deletion of multiple existing test assertions without equivalent additions
    if (deletedAssertionCount >= 3 && deletedAssertionCount > addedAssertionCount) {
      hasSuspiciousDeletions = true;
      diffNotes.push(`Anti-Tamper Warning: ${deletedAssertionCount} existing test assertions were deleted (${addedAssertionCount} added).`);
      blockingReasons.push(`Anti-tamper violation: ${deletedAssertionCount} test assertions were deleted without equivalent additions.`);
    }

    // Anti-Tamper Check: Detect package.json test script tampering to exit 0 or bypass test execution
    const pkgDiffContent = addedPackageJsonLines.join('\n');
    if (
      /\"(test|pretest|posttest)\"\s*:\s*\"(exit\s*0|true|echo\b.*exit\s*0|echo\b.*ok|node\s+-e\s+['"]process\.exit\(0\))/i.test(
        pkgDiffContent
      )
    ) {
      hasForbiddenModifications = true;
      diffNotes.push('Anti-Tamper Warning: package.json test script modified to trivially exit 0 or bypass execution.');
      blockingReasons.push('Anti-tamper violation: package.json test script was modified to bypass execution.');
    }

    // Placeholder Stubs Detection in added lines
    const addedCodeContent = addedAllLines.join('\n');
    if (
      /\/\/\s*TODO:\s*implement/i.test(addedCodeContent) ||
      /#\s*TODO:\s*implement/i.test(addedCodeContent) ||
      /\bthrow new NotImplementedError\b/i.test(addedCodeContent) ||
      /\bpass\s*#\s*todo\b/i.test(addedCodeContent)
    ) {
      hasPlaceholderStubs = true;
      diffNotes.push('Placeholder stub or unimplemented function found in diff.');
      blockingReasons.push('Implementation contains unfulfilled placeholder stubs or TODOs.');
    }

    // 5. Explicit Acceptance Criteria Verification
    // Intermediate step check vs Final task verification gate
    if (options?.isIntermediateStep) {
      // For intermediate milestones: verify step command or build syntax; do not evaluate final semantic criteria
      if (customVerificationCmd && testCheck.status === 'FAILED') {
        blockingReasons.push(`Step verification command failed: ${customVerificationCmd}`);
      }
    } else if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
      blockingReasons.push('No acceptance criteria specified for task verification.');
    } else {
      for (const criterion of acceptanceCriteria) {
        const lower = criterion.toLowerCase();
        let satisfied = false;
        let evidence = '';
        let checkType: CriterionVerification['checkType'] = 'targeted_check';
        let targetCommand: string | undefined;
        let exitCode: number | undefined;

        const isBuildCriterion =
          lower.includes('build') ||
          (lower.includes('compil') && !lower.includes('syntax')) ||
          (lower.includes('compil') && Boolean(meta.buildCmd));

        if (isBuildCriterion) {
          checkType = 'build';
          targetCommand = buildCheck.command || meta.buildCmd;
          exitCode = buildCheck.exitCode;
          satisfied = buildCheck.status === 'PASSED';
          evidence = satisfied
            ? targetCommand
              ? `Build check "${targetCommand}" succeeded (exit ${exitCode ?? 0}).`
              : 'Automated build completed successfully.'
            : buildCheck.status === 'NOT_CONFIGURED'
              ? 'Unverified: Build criterion specified but no build runner is configured or executed.'
              : `Build check failed (status: ${buildCheck.status}, exit ${exitCode ?? 1}).`;
        } else if (lower.includes('syntax')) {
          checkType = 'targeted_check';
          const testsPassed = testCheck.status === 'PASSED';
          satisfied = testsPassed || buildCheck.status === 'PASSED';
          evidence = satisfied
            ? `Syntax verified cleanly via runtime execution: "${testCheck.command || buildCheck.command || 'syntax check'}" (exit ${testCheck.exitCode ?? 0}).`
            : 'Syntax check failed: test or runtime execution produced errors.';
        } else if (
          lower.includes('unit test') ||
          lower.includes('test suite') ||
          lower.includes('unit tests pass') ||
          lower.includes('all tests pass')
        ) {
          checkType = 'test';
          targetCommand = testCheck.command || meta.testCmd;
          exitCode = testCheck.exitCode;
          satisfied = testCheck.status === 'PASSED';
          evidence = satisfied
            ? `Test suite "${targetCommand || 'test runner'}" passed cleanly (exit ${exitCode ?? 0}).`
            : `Test suite failed or not configured (status: ${testCheck.status}, exit ${exitCode ?? 'N/A'}).`;
        } else if (lower.includes('file presence') || lower.includes('create file') || lower.includes('add file')) {
          checkType = 'file_presence';
          const fileMatch = criterion.match(/[`"']?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)[`"']?/);
          const targetFile = fileMatch ? fileMatch[1].replace(/^[./\\]+/, '').toLowerCase() : undefined;

          if (targetFile) {
            let existsOnDisk = false;
            try {
              await fs.stat(path.join(this.workspacePath, targetFile));
              existsOnDisk = true;
            } catch {
              for (const cumFile of allCumulativeFiles) {
                if (cumFile.toLowerCase() === targetFile || cumFile.toLowerCase().endsWith('/' + targetFile)) {
                  try {
                    await fs.stat(path.join(this.workspacePath, cumFile));
                    existsOnDisk = true;
                    break;
                  } catch {}
                }
              }
            }

            const fileInDiff = allCumulativeFiles.some(
              (f) => f.toLowerCase() === targetFile || f.toLowerCase().endsWith('/' + targetFile)
            );
            satisfied = fileInDiff && existsOnDisk;
            evidence = satisfied
              ? `Confirmed required file "${targetFile}" created/modified in repository and verified on disk.`
              : !existsOnDisk && fileInDiff
                ? `Unverified: Required file "${targetFile}" was recorded in changes but does not exist on disk.`
                : `Unverified: Required file "${targetFile}" was not found in modified files: ${allCumulativeFiles.join(', ') || 'none'}.`;
          } else {
            satisfied = allCumulativeFiles.length > 0;
            evidence = satisfied
              ? `Confirmed file modification/creation in repository: ${allCumulativeFiles.join(', ')}.`
              : 'Unverified: No files were modified or created to satisfy presence requirement.';
          }
        } else {
          // Explicit Targeted Requirement Verification
          checkType = 'targeted_check';
          const hasChanges = allCumulativeFiles.length > 0 || Boolean(diff && diff.length > 0);
          const testsPassed = testCheck.status === 'PASSED';

          if (!hasChanges) {
            satisfied = false;
            evidence = `Unverified: No code modifications present in diff to satisfy "${criterion}".`;
          } else if (!testsPassed) {
            satisfied = false;
            evidence = `Unverified: Automated test suite failed (exit ${testCheck.exitCode ?? 1}) - behavioral requirement "${criterion}" not proven.`;
          } else {
            // Check for explicit targeted check command (not generic repository test runner)
            const verifiedByCommand = Boolean(customVerificationCmd && testCheck.command === customVerificationCmd);

            if (verifiedByCommand) {
              targetCommand = testCheck.command || customVerificationCmd;
              exitCode = testCheck.exitCode;
              satisfied = true;
              evidence = `Explicit verification check "${targetCommand}" verified requirement (exit ${exitCode ?? 0}).`;
            } else {
              const keywords = criterion
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, ' ')
                .split(/\s+/)
                .filter(
                  (w) =>
                    w.length >= 4 &&
                    !['test', 'pass', 'passes', 'should', 'must', 'with', 'when', 'from', 'that', 'this'].includes(w)
                );

              const hasDedicatedTestFile =
                allCumulativeFiles.some((f) => /test|spec/i.test(f)) ||
                Boolean(meta.testCmd && /test|spec/i.test(meta.testCmd)) ||
                Boolean(testCheck.command && /test|spec/i.test(testCheck.command));
              const outputLower = (testCheck.output || '').toLowerCase();
              const keywordMatches = keywords.filter((kw) => outputLower.includes(kw));

              if (
                (keywords.length > 0 && keywordMatches.length >= Math.min(2, keywords.length)) ||
                (hasDedicatedTestFile && keywordMatches.length >= 1)
              ) {
                targetCommand = testCheck.command || meta.testCmd;
                exitCode = testCheck.exitCode;
                satisfied = true;
                evidence = `Verified via targeted test execution: "${targetCommand}" (exit ${exitCode ?? 0}) with proof matching [${keywordMatches.join(', ')}].`;
              } else if (hasDedicatedTestFile && (/passed\b|✓|ok\b/i.test(testCheck.output))) {
                targetCommand = testCheck.command || meta.testCmd;
                exitCode = testCheck.exitCode;
                satisfied = true;
                evidence = `Verified via test execution "${targetCommand}" confirming assertions in test suite.`;
              } else {
                satisfied = false;
                evidence = `Unverified: General test suite passed, but no targeted test or assertion proved "${criterion}".`;
              }
            }
          }
        }

        if (!satisfied) {
          blockingReasons.push(`Acceptance criterion not verified: "${criterion}" (${evidence})`);
        }

        criteriaResults.push({
          criterion,
          satisfied,
          evidence,
          checkType,
          targetCommand,
          exitCode,
        });
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
    if (hasActiveFailures) {
      status = 'FAILED';
    } else if (
      !options?.isIntermediateStep &&
      buildCheck.status === 'NOT_CONFIGURED' &&
      testCheck.status === 'NOT_CONFIGURED' &&
      !customVerificationCmd
    ) {
      // P1 FIX: Distinguish "PASSED" from "NOT_CONFIGURED / INCONCLUSIVE"
      // Neither build nor test command was configured or executed, so no automated verification occurred.
      status = 'INCONCLUSIVE';
      blockingReasons.push(
        'Inconclusive verification: Neither a build command nor a test runner is configured, and no custom verification command ran.'
      );
    } else if (blockingReasons.length > 0) {
      status = 'FAILED';
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
        filesChanged: allCumulativeFiles,
        hasSuspiciousDeletions,
        hasForbiddenModifications,
        hasPlaceholderStubs,
        summary: diffNotes.length > 0 ? diffNotes.join('; ') : `Audited ${allCumulativeFiles.length} changed files cleanly.`,
      },
      diagnostics: diagnosticsList.join('\n\n'),
      blockingReasons,
    };
  }

  /**
   * P1 FIX: Independent anti-tamper and diff integrity auditor.
   */
  static verifyDiffIntegrity(diff: string, filesChanged: string[] = []): {
    isClean: boolean;
    hasForbiddenModifications: boolean;
    hasSuspiciousDeletions: boolean;
    hasPlaceholderStubs: boolean;
    diffNotes: string[];
    blockingReasons: string[];
  } {
    const blockingReasons: string[] = [];
    const diffNotes: string[] = [];
    let hasForbiddenModifications = false;
    let hasSuspiciousDeletions = false;
    let hasPlaceholderStubs = false;

    // Security check for sensitive secret files across all changed files
    for (const f of filesChanged) {
      if (SecurityPolicyEngine.isSensitiveSecret(f)) {
        hasForbiddenModifications = true;
        diffNotes.push(`Sensitive secret file modified in task history: ${f}`);
        blockingReasons.push(`Unauthorized modification of sensitive secret file: ${f}`);
      }
    }

    const secretInDiff = SecurityPolicyEngine.containsSensitiveSecret(diff);
    if (secretInDiff.hasSecret) {
      hasForbiddenModifications = true;
      diffNotes.push(`Diff contains sensitive secrets: ${secretInDiff.reason}`);
      blockingReasons.push(`Unauthorized sensitive credential pattern detected in diff: ${secretInDiff.reason}`);
    }

    const addedTestLines: string[] = [];
    const addedPackageJsonLines: string[] = [];
    const addedAllLines: string[] = [];
    const deletedTestLines: string[] = [];
    let deletedAssertionCount = 0;
    let addedAssertionCount = 0;
    let currentDiffFile = '';

    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+?)$/);
        currentDiffFile = match ? match[2].trim() : '';
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        const added = line.slice(1);
        addedAllLines.push(added);
        if (/(\.test\.|\.spec\.|(^|[\\/])tests?(\.|\/)|(^|[\\/])test_[a-z0-9_]+\.py)/i.test(currentDiffFile)) {
          addedTestLines.push(added);
          if (/\b(assert|expect|test|it)\s*[\.(]/i.test(added)) {
            addedAssertionCount++;
          }
        }
        if (currentDiffFile.endsWith('package.json')) {
          addedPackageJsonLines.push(added);
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const deleted = line.slice(1);
        if (/(\.test\.|\.spec\.|(^|[\\/])tests?(\.|\/)|(^|[\\/])test_[a-z0-9_]+\.py)/i.test(currentDiffFile)) {
          deletedTestLines.push(deleted);
          if (/\b(assert|expect|test|it)\s*[\.(]/i.test(deleted)) {
            deletedAssertionCount++;
          }
        }
      }
    }

    const testDiffContent = addedTestLines.join('\n');
    if (
      /\b(test\.skip|it\.skip|describe\.skip|xit|xdescribe)\s*\(/i.test(testDiffContent) ||
      /@pytest\.mark\.skip/i.test(testDiffContent)
    ) {
      hasSuspiciousDeletions = true;
      diffNotes.push('Anti-Tamper Warning: Suspicious test-skipping statements detected in test diff.');
      blockingReasons.push('Test assertions were bypassed or marked skipped in diff.');
    }

    if (deletedAssertionCount >= 3 && deletedAssertionCount > addedAssertionCount) {
      hasSuspiciousDeletions = true;
      diffNotes.push(
        `Anti-Tamper Warning: ${deletedAssertionCount} existing test assertions were deleted (${addedAssertionCount} added).`
      );
      blockingReasons.push(
        `Anti-tamper violation: ${deletedAssertionCount} test assertions were deleted without equivalent additions.`
      );
    }

    const pkgDiffContent = addedPackageJsonLines.join('\n');
    if (
      /\"(test|pretest|posttest)\"\s*:\s*\"(exit\s*0|true|echo\b.*exit\s*0|echo\b.*ok|node\s+-e\s+['"]process\.exit\(0\))/i.test(
        pkgDiffContent
      )
    ) {
      hasForbiddenModifications = true;
      diffNotes.push('Anti-Tamper Warning: package.json test script modified to trivially exit 0 or bypass execution.');
      blockingReasons.push('Anti-tamper violation: package.json test script was modified to bypass execution.');
    }

    const addedCodeContent = addedAllLines.join('\n');
    if (
      /\/\/\s*TODO:\s*implement/i.test(addedCodeContent) ||
      /#\s*TODO:\s*implement/i.test(addedCodeContent) ||
      /\bthrow new NotImplementedError\b/i.test(addedCodeContent) ||
      /\bpass\s*#\s*todo\b/i.test(addedCodeContent)
    ) {
      hasPlaceholderStubs = true;
      diffNotes.push('Placeholder stub or unimplemented function found in diff.');
      blockingReasons.push('Implementation contains unfulfilled placeholder stubs or TODOs.');
    }

    return {
      isClean: blockingReasons.length === 0,
      hasForbiddenModifications,
      hasSuspiciousDeletions,
      hasPlaceholderStubs,
      diffNotes,
      blockingReasons,
    };
  }

  verifyDiffIntegrity(diff: string, filesChanged: string[] = []) {
    return IndependentVerifier.verifyDiffIntegrity(diff, filesChanged);
  }
}
