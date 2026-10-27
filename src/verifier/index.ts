import { AgentToolbox, type CommandResult } from '../agent/tools.js';
import { RepoInspector, type ProjectMetadata } from '../repo/inspector.js';

export interface VerificationCheckResult {
  passed: boolean;
  command?: string;
  output: string;
  exitCode: number;
}

export interface VerificationReport {
  overallPassed: boolean;
  buildCheck: VerificationCheckResult;
  testCheck: VerificationCheckResult;
  lintCheck: VerificationCheckResult;
  diffAudit: {
    filesChanged: string[];
    hasSuspiciousDeletions: boolean;
    hasForbiddenModifications: boolean;
    summary: string;
  };
  diagnostics: string;
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
    customVerificationCmd?: string
  ): Promise<VerificationReport> {
    let overallPassed = true;
    const diagnosticsList: string[] = [];

    // 1. Build Verification
    let buildCheck: VerificationCheckResult = {
      passed: true,
      output: 'No build command detected or needed.',
      exitCode: 0,
    };
    if (meta.buildCmd) {
      const res = await this.toolbox.executeCommand(meta.buildCmd, 120000);
      buildCheck = {
        passed: res.exitCode === 0,
        command: meta.buildCmd,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
      };
      if (!buildCheck.passed) {
        overallPassed = false;
        diagnosticsList.push(`[BUILD FAILURE]: ${meta.buildCmd} exited with code ${res.exitCode}\n${res.stderr || res.stdout}`);
      }
    }

    // 2. Test Suite Verification
    let testCheck: VerificationCheckResult = {
      passed: true,
      output: 'No test suite detected.',
      exitCode: 0,
    };
    const testCmdToRun = customVerificationCmd || meta.testCmd;
    if (testCmdToRun) {
      const res = await this.toolbox.executeCommand(testCmdToRun, 180000);
      testCheck = {
        passed: res.exitCode === 0,
        command: testCmdToRun,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
      };
      if (!testCheck.passed) {
        overallPassed = false;
        diagnosticsList.push(`[TEST FAILURE]: ${testCmdToRun} exited with code ${res.exitCode}\n${res.stderr || res.stdout}`);
      }
    }

    // 3. Lint / Static Analysis Check
    let lintCheck: VerificationCheckResult = {
      passed: true,
      output: 'No linter detected.',
      exitCode: 0,
    };
    if (meta.lintCmd && buildCheck.passed) {
      const res = await this.toolbox.executeCommand(meta.lintCmd, 60000);
      lintCheck = {
        passed: res.exitCode === 0,
        command: meta.lintCmd,
        output: `${res.stdout}\n${res.stderr}`.trim(),
        exitCode: res.exitCode,
      };
      if (!lintCheck.passed) {
        // Lint failure can be logged as warning or failure
        diagnosticsList.push(`[LINT WARNING]: ${meta.lintCmd} flagged code style or lint issues.`);
      }
    }

    // 4. Git Diff Audit
    const diff = await this.inspector.getDiff();
    const gitStatus = await this.inspector.getGitStatus();
    const filesChanged = gitStatus ? gitStatus.files.map((f) => f.path) : [];

    let hasSuspiciousDeletions = false;
    let hasForbiddenModifications = false;
    const diffNotes: string[] = [];

    for (const f of filesChanged) {
      if (f.toLowerCase().includes('.env') || f.toLowerCase().includes('id_rsa') || f.toLowerCase().includes('credentials')) {
        hasForbiddenModifications = true;
        diffNotes.push(`Sensitive secret file modified: ${f}`);
      }
    }

    if (diff.includes('test.skip') || diff.includes('it.skip') || diff.includes('@pytest.mark.skip')) {
      hasSuspiciousDeletions = true;
      diffNotes.push('Suspicious test-skipping statements detected in diff.');
    }

    if (hasForbiddenModifications) {
      overallPassed = false;
      diagnosticsList.push(`[SECURITY ALERT]: Forbidden modification of sensitive configuration file detected.`);
    }

    return {
      overallPassed,
      buildCheck,
      testCheck,
      lintCheck,
      diffAudit: {
        filesChanged,
        hasSuspiciousDeletions,
        hasForbiddenModifications,
        summary: diffNotes.length > 0 ? diffNotes.join('; ') : `Changed ${filesChanged.length} files cleanly.`,
      },
      diagnostics: diagnosticsList.join('\n\n'),
    };
  }
}
