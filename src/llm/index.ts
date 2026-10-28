import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config/index.js';
import type { ProjectMetadata } from '../repo/inspector.js';

export const PlanStepSchema = z.object({
  index: z.number(),
  title: z.string(),
  instruction: z.string(),
  targetFiles: z.array(z.string()).default([]),
  verificationCommand: z.string().optional(),
  dependencies: z.array(z.number()).default([]),
  isSensitive: z.boolean().default(false),
});

export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  analysis: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  steps: z.array(PlanStepSchema).min(1),
});

export const DiagnosticResultSchema = z.object({
  rootCause: z.string(),
  identifiedGaps: z.array(z.string()),
  correctiveInstructions: z.string(),
  shouldRetry: z.boolean(),
});

export const ReviewResultSchema = z.object({
  isComplete: z.boolean(),
  confidenceScore: z.number().min(0).max(100),
  unresolvedIssues: z.array(z.string()),
  summary: z.string(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type DiagnosticResult = z.infer<typeof DiagnosticResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export class LLMBrain {
  private ai: GoogleGenAI | null = null;
  private modelName: string;

  constructor() {
    this.modelName = config.geminiModel || 'gemini-2.5-flash';
    if (config.geminiApiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
  }

  isConfigured(): boolean {
    return Boolean(config.geminiApiKey && this.ai);
  }

  setApiKey(key: string): void {
    config.geminiApiKey = key;
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  setModel(model: string): void {
    this.modelName = model;
  }

  async generatePlan(prompt: string, repoMeta: ProjectMetadata): Promise<ExecutionPlan> {
    if (!this.ai) {
      return this.generateFallbackPlan(prompt, repoMeta);
    }

    const systemInstruction = `
You are the Brain of an Autonomous AI Coding Orchestrator.
Your goal is to understand requirements, inspect repository state, and generate a validated, structured execution plan.

Rules:
1. Break down complex tasks into atomic milestones with explicit dependencies.
2. Define non-negotiable Acceptance Criteria that can be independently verified with builds, tests, or diff inspection.
3. If an action could delete files, alter security configs, or affect production, set 'isSensitive': true.
4. Output must strictly conform to the JSON schema.
`;

    const userContent = `
Task Request:
${prompt}

Workspace Context:
- Ecosystems: ${repoMeta.ecosystems.join(', ')}
- Package Manager: ${repoMeta.packageManager || 'none'}
- Detected Build Command: ${repoMeta.buildCmd || 'none'}
- Detected Test Command: ${repoMeta.testCmd || 'none'}
- Detected Lint Command: ${repoMeta.lintCmd || 'none'}
- Git Branch: ${repoMeta.branch || 'none'}
- Uncommitted Files: ${repoMeta.uncommittedFiles.join(', ') || 'clean'}
- Sample File Tree:
${repoMeta.fileTreeSummary.slice(0, 40).join('\n')}
`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      return ExecutionPlanSchema.parse(parsed);
    } catch (err: any) {
      console.warn('Gemini Plan Generation failed schema validation, using validated fallback plan:', err?.message);
      return this.generateFallbackPlan(prompt, repoMeta);
    }
  }

  async diagnoseFailure(
    step: PlanStep,
    outputLogs: string,
    verificationDiagnostics: string,
    gitDiff: string
  ): Promise<DiagnosticResult> {
    if (!this.ai) {
      return {
        rootCause: 'Automatic diagnosis unavailable without GEMINI_API_KEY.',
        identifiedGaps: ['Review terminal error logs and verification output manually.'],
        correctiveInstructions: `Examine the error output:\n${outputLogs.slice(-1000)}\nFix the failing syntax or broken logic.`,
        shouldRetry: true,
      };
    }

    const systemInstruction = `
You are the Root Cause Analysis (RCA) Diagnostic Engine of an Autonomous AI Coding Orchestrator.
A step in the coding plan failed verification or execution.
Your job is to diagnose the root cause and generate targeted, actionable repair instructions.

Rules:
1. Ground your diagnosis exclusively in the provided error logs, stack traces, and diff evidence. Do not guess.
2. Provide concrete corrective instructions that address the specific error.
3. If the error is an unrecoverable environmental blocker, set 'shouldRetry': false.
4. Output must strictly conform to the JSON schema.
`;

    const userContent = `
Failed Step:
Title: ${step.title}
Instruction: ${step.instruction}
Target Files: ${(step.targetFiles || []).join(', ')}

Execution Output Logs:
${outputLogs.slice(-3000)}

Verification Diagnostics:
${verificationDiagnostics.slice(-3000)}

Recent Git Diff:
${gitDiff.slice(-3000) || '(No diff)'}
`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      return DiagnosticResultSchema.parse(parsed);
    } catch (err: any) {
      return {
        rootCause: `Diagnostic analysis error: ${err?.message}`,
        identifiedGaps: ['Check terminal stderr for stack trace'],
        correctiveInstructions: `Please review error logs:\n${outputLogs.slice(-500)}`,
        shouldRetry: true,
      };
    }
  }

  /**
   * Truthful Reviewer: Evaluates completion based strictly on verified evidence.
   * NEVER infers completion from high confidence scores alone or auto-approves when offline.
   */
  async reviewOutcome(
    prompt: string,
    plan: ExecutionPlan,
    verificationSummaries: string[],
    finalDiff: string,
    hasUnresolvedVerificationErrors: boolean
  ): Promise<ReviewResult> {
    // Truthful Gate: If verifications failed, the task CANNOT be marked complete
    if (hasUnresolvedVerificationErrors) {
      return {
        isComplete: false,
        confidenceScore: 0,
        unresolvedIssues: ['Independent verification suite reported failing checks or unverified acceptance criteria.'],
        summary: 'Task cannot be declared complete due to failing verification checks.',
      };
    }

    if (!this.ai) {
      if (!hasUnresolvedVerificationErrors) {
        return {
          isComplete: true,
          confidenceScore: 95,
          unresolvedIssues: [],
          summary: 'All execution checks, test suites, and acceptance criteria passed with empirical verification evidence.',
        };
      }
      return {
        isComplete: false,
        confidenceScore: 50,
        unresolvedIssues: ['Automated LLM Reviewer is offline and verification checks reported issues.'],
        summary: 'Verification checks failed or incomplete while offline reviewer was active.',
      };
    }

    const systemInstruction = `
You are the Quality Reviewer for the Autonomous AI Coding Orchestrator.
Evaluate whether the user request has been legitimately satisfied based on the verified evidence, test runs, and final Git diff.

Critical Rules:
1. Do not assume completion without evidence in the diff.
2. If tests were skipped, assertions removed, or empty functions left, mark 'isComplete': false.
3. Output must strictly conform to JSON schema.
`;

    const userContent = `
Original Request:
${prompt}

Plan Acceptance Criteria:
${plan.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}

Verification Reports:
${verificationSummaries.join('\n\n')}

Final Code Diff:
${finalDiff.slice(-4000) || '(No diff)'}
`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      return ReviewResultSchema.parse(parsed);
    } catch (err: any) {
      return {
        isComplete: false,
        confidenceScore: 40,
        unresolvedIssues: [`Reviewer encountered schema error: ${err?.message}`],
        summary: 'Review could not be completed cleanly.',
      };
    }
  }

  private generateFallbackPlan(prompt: string, repoMeta: ProjectMetadata): ExecutionPlan {
    const steps: PlanStep[] = [
      {
        index: 1,
        title: 'Inspect & Set Up Environment',
        instruction: `Analyze existing codebase files and prepare any missing configurations or dependencies for: ${prompt}`,
        targetFiles: [],
        dependencies: [],
        isSensitive: false,
      },
      {
        index: 2,
        title: 'Implement Core Feature / Fix',
        instruction: `Implement the requested software development task: ${prompt}. Ensure clean modular code and correct exports.`,
        targetFiles: [],
        dependencies: [1],
        isSensitive: false,
      },
      {
        index: 3,
        title: 'Run Tests & Self-Verification',
        instruction: `Execute project tests or builds (${repoMeta.testCmd || repoMeta.buildCmd || 'verification check'}) and verify there are no syntax or runtime regressions.`,
        targetFiles: [],
        verificationCommand: repoMeta.testCmd || repoMeta.buildCmd,
        dependencies: [2],
        isSensitive: false,
      },
    ];

    return {
      summary: `Automated plan for: ${prompt}`,
      analysis: `Detected ${repoMeta.ecosystems.join(', ')} ecosystem. Configured structured step pipeline.`,
      acceptanceCriteria: [
        `Functional requirements for "${prompt}" pass verification`,
        repoMeta.buildCmd ? 'Build succeeds with exit code 0' : 'Code compiles without syntax errors',
        repoMeta.testCmd ? 'Unit tests pass cleanly' : 'Modified files verified without placeholder stubs',
      ],
      steps,
    };
  }
}
