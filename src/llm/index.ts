import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config/index.js';
import type { ProjectMetadata } from '../repo/inspector.js';

export const PlanStepSchema = z.object({
  index: z.number(),
  title: z.string(),
  instruction: z.string(),
  targetFiles: z.array(z.string()).default([]),
  verificationCommand: z.string().nullish(),
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

export interface TokenUsageMetadata {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  measuredCost: number;
  isEstimate?: boolean;
}

export const GEMINI_MODEL_PRICING: Record<string, { promptPerM: number; candidatesPerM: number }> = {
  'gemini-flash-lite-latest': { promptPerM: 0.075, candidatesPerM: 0.30 },
  'gemini-2.5-flash': { promptPerM: 0.15, candidatesPerM: 0.60 },
  'gemini-2.0-flash': { promptPerM: 0.10, candidatesPerM: 0.40 },
  'gemini-1.5-flash': { promptPerM: 0.075, candidatesPerM: 0.30 },
  'gemini-1.5-pro': { promptPerM: 1.25, candidatesPerM: 5.00 },
};

export function calculateGeminiCost(
  promptTokens: number,
  candidatesTokens: number,
  modelName: string = config.geminiModel || 'gemini-flash-lite-latest'
): number {
  // Model-specific pricing estimation (telemetry metric, not authoritative invoice)
  const pricing = GEMINI_MODEL_PRICING[modelName] || { promptPerM: 0.075, candidatesPerM: 0.30 };
  return (promptTokens * pricing.promptPerM) / 1_000_000 + (candidatesTokens * pricing.candidatesPerM) / 1_000_000;
}

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type DiagnosticResult = z.infer<typeof DiagnosticResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export class LLMBrain {
  private ai: GoogleGenAI | null = null;
  private modelName: string;
  private tokenUsage: TokenUsageMetadata = { promptTokens: 0, candidatesTokens: 0, totalTokens: 0, measuredCost: 0 };

  constructor() {
    this.modelName = config.geminiModel || 'gemini-flash-lite-latest';
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

  getTokenUsage(): TokenUsageMetadata {
    return { ...this.tokenUsage };
  }

  private recordUsage(usageMetadata?: any): void {
    if (!usageMetadata) return;
    const p = usageMetadata.promptTokenCount || 0;
    const c = usageMetadata.candidatesTokenCount || 0;
    this.tokenUsage.promptTokens += p;
    this.tokenUsage.candidatesTokens += c;
    this.tokenUsage.totalTokens += usageMetadata.totalTokenCount || (p + c);
    this.tokenUsage.measuredCost = calculateGeminiCost(
      this.tokenUsage.promptTokens,
      this.tokenUsage.candidatesTokens,
      this.modelName
    );
    this.tokenUsage.isEstimate = true;
  }

  async generatePlan(prompt: string, repoMeta: ProjectMetadata): Promise<ExecutionPlan> {
    if (!this.ai) {
      return this.generateFallbackPlan(prompt, repoMeta);
    }

    const systemInstruction = `
You are the Brain of an Autonomous AI Coding Orchestrator.
Your goal is to understand requirements, inspect repository state, and generate a validated, structured execution plan.

Rules:
1. Every plan step must be an actionable code change, test creation, or configuration milestone. Do NOT create separate "inspection-only", "analysis", or "review" steps because the agent automatically inspects workspace files as part of step execution.
2. For focused bug repairs, logic updates, or contract refactorings, formulate a direct, concise 1-step or 2-step actionable plan that directly addresses the required files.
3. For multi-file changes or coordinated refactorings, specify all interdependent files in 'targetFiles' (e.g. caller and callee modules) so the agent has complete cross-file contract context.
4. Set 'verificationCommand' to the test command on the milestone that finishes the fix (or null if it is an intermediate preparation step).
5. Define non-negotiable Acceptance Criteria that can be independently verified with builds, tests, or diff inspection.
6. If an action could delete files, alter security configs, or affect production, set 'isSensitive': true.
7. Output your response ONLY in valid JSON matching this exact structure:
{
  "summary": "High-level summary of the plan",
  "analysis": "Technical analysis of the problem and workspace",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
  "steps": [
    {
      "index": 1,
      "title": "Step title",
      "instruction": "Actionable, clear instruction for the agent to execute",
      "targetFiles": ["file1.js"],
      "verificationCommand": "npm.cmd test (or null if not applicable)",
      "dependencies": [],
      "isSensitive": false
    }
  ]
}
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
      let response: any;
      let attempts = 0;
      while (attempts < 3) {
        try {
          response = await this.ai.models.generateContent({
            model: this.modelName,
            contents: userContent,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
            },
          });
          break;
        } catch (planErr: any) {
          attempts++;
          const errMsg = planErr?.message || '';
          const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('limit: 5');
          const isUnavailable = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand');
          if ((isRateLimit || isUnavailable) && attempts < 3) {
            let waitMs = 15000;
            const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
            if (match) {
              const parsedSec = parseFloat(match[1]);
              waitMs = (parsedSec > 1000 ? Math.ceil(parsedSec) : Math.ceil(parsedSec * 1000)) + 1000;
            }
            waitMs = Math.min(Math.max(waitMs, 5000), 30000);
            console.warn(`[Gemini Backoff] Planning received ${isRateLimit ? '429 Rate Limit' : '503 High Demand'}. Pausing ${Math.round(waitMs / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw planErr;
        }
      }

      this.recordUsage(response?.usageMetadata);
      const parsed = JSON.parse(response?.text || '{}');
      return ExecutionPlanSchema.parse(parsed);
    } catch (err: any) {
      if (process.env.REQUIRE_LLM === 'true') {
        throw new Error(`Gemini Plan Generation failed and REQUIRE_LLM=true: ${err?.message}`);
      }
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
      let response: any;
      let attempts = 0;
      while (attempts < 3) {
        try {
          response = await this.ai.models.generateContent({
            model: this.modelName,
            contents: userContent,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
            },
          });
          break;
        } catch (diagErr: any) {
          attempts++;
          const errMsg = diagErr?.message || '';
          const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('limit: 5');
          const isUnavailable = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand');
          if ((isRateLimit || isUnavailable) && attempts < 3) {
            let waitMs = 15000;
            const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
            if (match) {
              const parsedSec = parseFloat(match[1]);
              waitMs = (parsedSec > 1000 ? Math.ceil(parsedSec) : Math.ceil(parsedSec * 1000)) + 1000;
            }
            waitMs = Math.min(Math.max(waitMs, 5000), 30000);
            console.warn(`[Gemini Backoff] Diagnosis received ${isRateLimit ? '429 Rate Limit' : '503 High Demand'}. Pausing ${Math.round(waitMs / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw diagErr;
        }
      }

      this.recordUsage(response?.usageMetadata);
      const parsed = JSON.parse(response?.text || '{}');
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
   * Evaluates whether empirical verification evidence is authoritative and trusted enough
   * to authorize task completion when an LLM reviewer is offline, unavailable, or encounters an error.
   * Fail-Closed: Rejects unconfigured tests, missing verification runs, failing checks, or empty diffs.
   */
  hasTrustedVerificationEvidence(
    verificationSummaries: string[],
    finalDiff: string,
    hasUnresolvedVerificationErrors: boolean
  ): { trusted: boolean; reason?: string } {
    if (hasUnresolvedVerificationErrors) {
      return { trusted: false, reason: 'Independent verification reported unresolved errors or failing criteria.' };
    }

    if (!verificationSummaries || verificationSummaries.length === 0) {
      return { trusted: false, reason: 'Incomplete verification: No verification records were captured.' };
    }

    if (!finalDiff || finalDiff.trim().length === 0) {
      return { trusted: false, reason: 'Missing code changes: Final Git diff is empty.' };
    }

    // Inspect the latest / final verification summary for authoritative outcome (index 0 is newest from DESC query)
    const latestSummary = verificationSummaries[0];

    if (latestSummary.includes('Test: FAILED') || latestSummary.includes('[FAILED]')) {
      return { trusted: false, reason: 'Latest verification summary indicates failing test checks.' };
    }
    if (latestSummary.includes('Build: FAILED')) {
      return { trusted: false, reason: 'Latest verification summary indicates build failure.' };
    }
    if (latestSummary.includes('Test: NOT_CONFIGURED')) {
      return { trusted: false, reason: 'Tests are not configured for this repository; cannot authorize unverified completion.' };
    }
    if (latestSummary.includes('Test: NOT_RUN') || latestSummary.includes('Test: SKIPPED')) {
      return { trusted: false, reason: 'Configured test suite was not executed or was skipped.' };
    }

    // Must have verified test with status PASSED
    if (!latestSummary.includes('Test: PASSED')) {
      return { trusted: false, reason: 'Latest verification did not record a PASSED test check.' };
    }

    return { trusted: true };
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
      const verifCheck = this.hasTrustedVerificationEvidence(verificationSummaries, finalDiff, hasUnresolvedVerificationErrors);
      if (verifCheck.trusted) {
        return {
          isComplete: true,
          confidenceScore: 95,
          unresolvedIssues: [],
          summary: 'All execution checks, test suites, and acceptance criteria passed with verified empirical evidence.',
        };
      }
      return {
        isComplete: false,
        confidenceScore: 0,
        unresolvedIssues: [`Offline reviewer cannot verify completion: ${verifCheck.reason}`],
        summary: `Verification evidence insufficient or untrusted: ${verifCheck.reason}`,
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
      let response: any;
      let attempts = 0;
      while (attempts < 3) {
        try {
          response = await this.ai.models.generateContent({
            model: this.modelName,
            contents: userContent,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
            },
          });
          break;
        } catch (revErr: any) {
          attempts++;
          const errMsg = revErr?.message || '';
          const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('limit: 5');
          const isUnavailable = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand');
          if ((isRateLimit || isUnavailable) && attempts < 3) {
            let waitMs = 15000;
            const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
            if (match) {
              const parsedSec = parseFloat(match[1]);
              waitMs = (parsedSec > 1000 ? Math.ceil(parsedSec) : Math.ceil(parsedSec * 1000)) + 1000;
            }
            waitMs = Math.min(Math.max(waitMs, 5000), 30000);
            console.warn(`[Gemini Backoff] Review received ${isRateLimit ? '429 Rate Limit' : '503 High Demand'}. Pausing ${Math.round(waitMs / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw revErr;
        }
      }

      this.recordUsage(response?.usageMetadata);
      const parsed = JSON.parse(response.text || '{}');
      return ReviewResultSchema.parse(parsed);
    } catch (err: any) {
      const verifCheck = this.hasTrustedVerificationEvidence(verificationSummaries, finalDiff, hasUnresolvedVerificationErrors);
      if (verifCheck.trusted) {
        return {
          isComplete: true,
          confidenceScore: 90,
          unresolvedIssues: [],
          summary: 'All requirements verified by independent test suite with verified diff evidence.',
        };
      }
      return {
        isComplete: false,
        confidenceScore: 0,
        unresolvedIssues: [
          `Reviewer encountered error (${err?.message}) and independent verification is insufficient: ${verifCheck.reason}`,
        ],
        summary: `Task review failed closed: ${verifCheck.reason}`,
      };
    }
  }

  private generateFallbackPlan(prompt: string, repoMeta: ProjectMetadata): ExecutionPlan {
    const steps: PlanStep[] = [
      {
        index: 1,
        title: 'Diagnose and Implement Solution',
        instruction: `Inspect files, diagnose requirements or failures, apply necessary code changes, and verify that tests pass for: ${prompt}`,
        targetFiles: [],
        verificationCommand: repoMeta.testCmd || repoMeta.buildCmd,
        dependencies: [],
        isSensitive: false,
      },
    ];

    return {
      summary: `Automated plan for: ${prompt}`,
      analysis: `Detected ${repoMeta.ecosystems.join(', ')} ecosystem. Configured structured step pipeline.`,
      acceptanceCriteria: [
        `Functional requirements for "${prompt}" pass verification`,
        repoMeta.buildCmd
          ? 'Build succeeds with exit code 0'
          : 'Syntax is valid with clean runtime execution',
        repoMeta.testCmd ? 'Unit tests pass cleanly' : 'Modified files verified without placeholder stubs',
      ],
      steps,
    };
  }
}
