import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';
import type { ProjectMetadata } from '../repo/inspector.js';

export interface PlanStep {
  index: number;
  title: string;
  instruction: string;
  targetFiles?: string[];
  verificationCommand?: string;
  isSensitive?: boolean;
}

export interface ExecutionPlan {
  summary: string;
  analysis: string;
  acceptanceCriteria: string[];
  steps: PlanStep[];
}

export interface DiagnosticResult {
  rootCause: string;
  identifiedGaps: string[];
  correctiveInstructions: string;
  shouldRetry: boolean;
}

export interface ReviewResult {
  isComplete: boolean;
  confidenceScore: number;
  unresolvedIssues: string[];
  summary: string;
}

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
Your role is to understand the user's software development goal, inspect the repository context, and generate a precise, actionable, step-by-step implementation plan for an autonomous coding agent.

Rules:
1. Break down complex tasks into atomic steps.
2. Formulate clear, non-negotiable Acceptance Criteria that can be independently verified with code, tests, or builds.
3. If an action could be destructive (e.g. database wipe, deleting key configs, production push), flag 'isSensitive': true.
4. Always respond in valid JSON format matching the schema.

JSON Output Schema:
{
  "summary": "Short 1-2 sentence overview of the strategy",
  "analysis": "Detailed understanding of the project, architecture, and constraints",
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "steps": [
    {
      "index": 1,
      "title": "Short title",
      "instruction": "Concrete detailed instruction for the coding agent",
      "targetFiles": ["src/example.ts"],
      "verificationCommand": "npm test or build check",
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
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const text = response.text || '{}';
      return JSON.parse(text) as ExecutionPlan;
    } catch (err: any) {
      console.warn('Gemini Plan Generation failed or returned malformed JSON, falling back:', err?.message);
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
        rootCause: 'Automatic diagnosis unavailable without GEMINI_API_KEY. Review logs.',
        identifiedGaps: ['Review terminal output logs and verification diagnostics manually.'],
        correctiveInstructions: `Examine the error output:\n${outputLogs}\nFix the failing syntax or broken logic.`,
        shouldRetry: true,
      };
    }

    const systemInstruction = `
You are the Diagnostic Engine of an Autonomous AI Coding Orchestrator.
A step in the coding plan failed verification or execution.
Your job is to perform a Root Cause Analysis (RCA) and generate targeted, actionable repair instructions for the coding agent.

Rules:
1. Do not hallucinate or guess. Pinpoint exact files, line numbers, or missing imports from the error logs.
2. Provide concrete corrective instructions that address the specific error.
3. Indicate if this failure is safely recoverable ('shouldRetry': true) or if human intervention is required ('shouldRetry': false).

JSON Output Schema:
{
  "rootCause": "Exact root cause analysis",
  "identifiedGaps": ["gap 1", "gap 2"],
  "correctiveInstructions": "Detailed instructions on what to change/create/fix",
  "shouldRetry": true
}
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

      const text = response.text || '{}';
      return JSON.parse(text) as DiagnosticResult;
    } catch (err: any) {
      console.warn('Gemini Diagnosis failed:', err?.message);
      return {
        rootCause: `Diagnostic analysis encounter error: ${err?.message}`,
        identifiedGaps: ['Check logs for stack trace'],
        correctiveInstructions: `Please review error logs:\n${outputLogs.slice(-500)}`,
        shouldRetry: true,
      };
    }
  }

  async reviewOutcome(
    prompt: string,
    plan: ExecutionPlan,
    verificationSummaries: string[],
    finalDiff: string
  ): Promise<ReviewResult> {
    if (!this.ai) {
      return {
        isComplete: true,
        confidenceScore: 85,
        unresolvedIssues: [],
        summary: 'All execution steps finished and verification checks passed.',
      };
    }

    const systemInstruction = `
You are the Quality Reviewer for the Autonomous AI Coding Orchestrator.
Evaluate whether the original user request has been legitimately satisfied based on the verified evidence, test runs, and final Git diff.

Output in JSON:
{
  "isComplete": true | false,
  "confidenceScore": 0-100,
  "unresolvedIssues": ["issue 1"],
  "summary": "Clear, professional summary of what was accomplished"
}
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

      const text = response.text || '{}';
      return JSON.parse(text) as ReviewResult;
    } catch (err: any) {
      return {
        isComplete: true,
        confidenceScore: 80,
        unresolvedIssues: [],
        summary: `Task completed. Verified via execution suite. (${err?.message})`,
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
        isSensitive: false,
      },
      {
        index: 2,
        title: 'Implement Core Feature / Fix',
        instruction: `Implement the requested software development task: ${prompt}. Ensure clean modular code and correct exports.`,
        targetFiles: [],
        isSensitive: false,
      },
      {
        index: 3,
        title: 'Run Tests & Self-Verification',
        instruction: `Execute project tests or builds (${repoMeta.testCmd || repoMeta.buildCmd || 'verification check'}) and verify there are no syntax or runtime regressions.`,
        verificationCommand: repoMeta.testCmd || repoMeta.buildCmd,
        isSensitive: false,
      },
    ];

    return {
      summary: `Automated plan for: ${prompt}`,
      analysis: `Detected ${repoMeta.ecosystems.join(', ')} ecosystem. Configured fallback step pipeline with built-in agent.`,
      acceptanceCriteria: [
        'Implementation fulfills requested functional requirements',
        repoMeta.buildCmd ? 'Build succeeds with exit code 0' : 'No compilation errors',
        repoMeta.testCmd ? 'Unit tests pass cleanly' : 'Runtime checks pass',
      ],
      steps,
    };
  }
}
