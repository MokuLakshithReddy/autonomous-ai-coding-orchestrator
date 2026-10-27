import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { RepoInspector, type ProjectMetadata } from '../repo/inspector.js';
import { LLMBrain, type ExecutionPlan, type PlanStep } from '../llm/index.js';
import { BuiltInAutonomousAgent, type CodingAgent } from '../agent/index.js';
import { IndependentVerifier, type VerificationReport } from '../verifier/index.js';
import {
  taskRepo,
  stepRepo,
  verificationRepo,
  approvalRepo,
  type TaskRecord,
  type StepRecord,
} from '../db/index.js';
import { config } from '../config/index.js';

export interface OrchestratorEvent {
  id: string;
  taskId: string;
  stepId?: string;
  type:
    | 'TASK_CREATED'
    | 'REPO_INSPECTED'
    | 'PLAN_GENERATED'
    | 'STEP_STARTED'
    | 'APPROVAL_REQUIRED'
    | 'APPROVAL_RESOLVED'
    | 'STEP_EXECUTED'
    | 'STEP_VERIFYING'
    | 'VERIFICATION_PASSED'
    | 'VERIFICATION_FAILED'
    | 'DIAGNOSING_ERROR'
    | 'REPAIR_ATTEMPT'
    | 'STEP_COMPLETED'
    | 'TASK_COMPLETED'
    | 'TASK_FAILED'
    | 'TASK_BLOCKED'
    | 'LOG';
  message: string;
  data?: any;
  timestamp: string;
}

export class OrchestrationEngine extends EventEmitter {
  private activeTasks = new Map<string, { abortController: AbortController }>();

  constructor() {
    super();
  }

  emitOrchestratorEvent(event: Omit<OrchestratorEvent, 'id' | 'timestamp'>): void {
    const fullEvent: OrchestratorEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.emit('event', fullEvent);
  }

  async runTask(params: {
    prompt: string;
    workspacePath: string;
    title?: string;
    maxRetries?: number;
    customAgent?: CodingAgent;
  }): Promise<TaskRecord> {
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxRetries = params.maxRetries ?? config.maxRetryBudget;
    const title = params.title || params.prompt.slice(0, 60);

    const task: TaskRecord = {
      id: taskId,
      title,
      prompt: params.prompt,
      workspacePath: params.workspacePath,
      status: 'INITIALIZING' as any,
      retryCount: 0,
      maxRetries,
      createdAt: now,
      updatedAt: now,
    };

    await taskRepo.create(task);
    this.emitOrchestratorEvent({
      taskId,
      type: 'TASK_CREATED',
      message: `Task initialized: "${title}"`,
      data: task,
    });

    const abortController = new AbortController();
    this.activeTasks.set(taskId, { abortController });

    // Run lifecycle asynchronously
    this.executeTaskLifecycle(taskId, params).catch((err) => {
      console.error(`Unhandled error in task ${taskId}:`, err);
      taskRepo.updateStatus(taskId, 'FAILED', `Internal failure: ${err.message}`);
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_FAILED',
        message: `Task failed with error: ${err.message}`,
      });
    });

    return task;
  }

  private async executeTaskLifecycle(
    taskId: string,
    params: {
      prompt: string;
      workspacePath: string;
      maxRetries?: number;
      customAgent?: CodingAgent;
    }
  ): Promise<void> {
    const inspector = new RepoInspector(params.workspacePath);
    const brain = new LLMBrain();
    const verifier = new IndependentVerifier(params.workspacePath);
    const agent = params.customAgent || new BuiltInAutonomousAgent(params.workspacePath);

    // 1. Repo Inspection
    await taskRepo.updateStatus(taskId, 'PLANNING');
    const repoMeta = await inspector.inspect();
    this.emitOrchestratorEvent({
      taskId,
      type: 'REPO_INSPECTED',
      message: `Workspace inspected: ${repoMeta.ecosystems.join(', ')} ecosystem detected.`,
      data: repoMeta,
    });

    // 2. Planning Phase
    const plan: ExecutionPlan = await brain.generatePlan(params.prompt, repoMeta);
    await taskRepo.updatePlan(taskId, JSON.stringify(plan));
    this.emitOrchestratorEvent({
      taskId,
      type: 'PLAN_GENERATED',
      message: `Plan formulated with ${plan.steps.length} milestones.`,
      data: plan,
    });

    // Create DB records for steps
    const stepRecords: StepRecord[] = [];
    for (const step of plan.steps) {
      const stepRecord: StepRecord = {
        id: crypto.randomUUID(),
        taskId,
        stepIndex: step.index,
        title: step.title,
        instruction: step.instruction,
        status: 'PENDING',
        agent: agent.name,
        createdAt: new Date().toISOString(),
      };
      await stepRepo.create(stepRecord);
      stepRecords.push(stepRecord);
    }

    // 3. Step Execution Loop
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepRec = stepRecords[i];

      // Handle Sensitive Steps Approval Gate
      if (step.isSensitive && config.requireApprovalForDestructive) {
        await taskRepo.updateStatus(taskId, 'AWAITING_APPROVAL');
        const approvalId = crypto.randomUUID();
        await approvalRepo.create({
          id: approvalId,
          taskId,
          stepId: stepRec.id,
          actionType: 'SENSITIVE_STEP',
          details: `Step "${step.title}" requires human approval before proceeding: ${step.instruction}`,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        });

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'APPROVAL_REQUIRED',
          message: `Approval requested for step: "${step.title}"`,
          data: { approvalId, step },
        });

        const approved = await this.waitForApproval(approvalId);
        if (!approved) {
          await stepRepo.update(stepRec.id, { status: 'SKIPPED' });
          this.emitOrchestratorEvent({
            taskId,
            stepId: stepRec.id,
            type: 'APPROVAL_RESOLVED',
            message: `Step "${step.title}" was rejected by human operator.`,
          });
          continue;
        }
      }

      await taskRepo.updateStatus(taskId, 'EXECUTING');
      await stepRepo.update(stepRec.id, { status: 'RUNNING' });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_STARTED',
        message: `Step ${step.index}/${plan.steps.length}: "${step.title}" started.`,
        data: step,
      });

      // Checkpoint before executing
      await inspector.createCheckpointCommit(`pre-step-${step.index}: ${step.title}`);

      // Execute Step with Agent
      let currentInstruction = step.instruction;
      let executionResult = await agent.executeStep(currentInstruction, step.targetFiles);

      await stepRepo.update(stepRec.id, {
        outputLog: executionResult.logs,
        toolsUsedJson: JSON.stringify(executionResult.toolsUsed),
        diffSummary: executionResult.diffSummary,
        exitCode: executionResult.exitCode,
      });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_EXECUTED',
        message: `Agent finished execution for "${step.title}". Triggering independent verification.`,
        data: executionResult,
      });

      // 4. Verification and Self-Repair Loop
      await taskRepo.updateStatus(taskId, 'VERIFYING');
      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_VERIFYING',
        message: `Verifying step "${step.title}"...`,
      });

      let verification = await verifier.verify(repoMeta, step.verificationCommand);
      let stepRetries = 0;
      const maxRetries = params.maxRetries ?? config.maxRetryBudget;

      while (!verification.overallPassed && stepRetries < maxRetries) {
        stepRetries++;
        await taskRepo.incrementRetry(taskId);

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'VERIFICATION_FAILED',
          message: `Verification failed on step "${step.title}" (Attempt ${stepRetries}/${maxRetries}).`,
          data: verification,
        });

        await verificationRepo.record({
          id: crypto.randomUUID(),
          taskId,
          stepId: stepRec.id,
          status: 'FAILED',
          buildStatus: verification.buildCheck.passed ? 'PASSED' : 'FAILED',
          testStatus: verification.testCheck.passed ? 'PASSED' : 'FAILED',
          lintStatus: verification.lintCheck.passed ? 'PASSED' : 'FAILED',
          diffInspection: verification.diffAudit.summary,
          detailsJson: JSON.stringify(verification),
          diagnostics: verification.diagnostics,
          createdAt: new Date().toISOString(),
        });

        // Diagnose with LLM Brain
        await taskRepo.updateStatus(taskId, 'DIAGNOSING');
        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'DIAGNOSING_ERROR',
          message: `Diagnosing root cause with LLM Brain...`,
        });

        const recentDiff = await inspector.getDiff();
        const diagnostic = await brain.diagnoseFailure(
          step,
          executionResult.logs,
          verification.diagnostics,
          recentDiff
        );

        if (!diagnostic.shouldRetry) {
          this.emitOrchestratorEvent({
            taskId,
            stepId: stepRec.id,
            type: 'TASK_BLOCKED',
            message: `LLM Diagnostician flagged unrecoverable error: ${diagnostic.rootCause}`,
            data: diagnostic,
          });
          await taskRepo.updateStatus(taskId, 'BLOCKED', diagnostic.rootCause);
          return;
        }

        // Automatic Repair Attempt
        await taskRepo.updateStatus(taskId, 'REPAIRING');
        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'REPAIR_ATTEMPT',
          message: `Initiating repair dispatch for step "${step.title}": ${diagnostic.correctiveInstructions}`,
          data: diagnostic,
        });

        currentInstruction = `${step.instruction}\n\nCORRECTIVE REPAIR INSTRUCTIONS:\n${diagnostic.correctiveInstructions}`;
        executionResult = await agent.executeStep(currentInstruction, step.targetFiles);

        // Reverification
        verification = await verifier.verify(repoMeta, step.verificationCommand);
      }

      // Check if step permanently failed
      if (!verification.overallPassed) {
        await taskRepo.updateStatus(taskId, 'FAILED', `Exhausted retry budget for step "${step.title}".`);
        await stepRepo.update(stepRec.id, { status: 'FAILED' });

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'TASK_FAILED',
          message: `Task halted: Verification could not be satisfied within retry budget (${maxRetries} retries).`,
          data: verification,
        });
        return;
      }

      // Step passed!
      await stepRepo.update(stepRec.id, {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
      });

      await verificationRepo.record({
        id: crypto.randomUUID(),
        taskId,
        stepId: stepRec.id,
        status: 'PASSED',
        buildStatus: verification.buildCheck.passed ? 'PASSED' : 'SKIPPED',
        testStatus: verification.testCheck.passed ? 'PASSED' : 'SKIPPED',
        lintStatus: verification.lintCheck.passed ? 'PASSED' : 'SKIPPED',
        diffInspection: verification.diffAudit.summary,
        detailsJson: JSON.stringify(verification),
        createdAt: new Date().toISOString(),
      });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'VERIFICATION_PASSED',
        message: `Step "${step.title}" verified successfully!`,
        data: verification,
      });

      // Post-step checkpoint
      await inspector.createCheckpointCommit(`post-step-${step.index}: ${step.title}`);
    }

    // 5. Final Outcome Review
    const finalDiff = await inspector.getDiff();
    const verifications = await verificationRepo.listForTask(taskId);
    const verifSummaries = verifications.map((v) => `[${v.status}] Build: ${v.buildStatus}, Test: ${v.testStatus}, Diff: ${v.diffInspection}`);
    const review = await brain.reviewOutcome(params.prompt, plan, verifSummaries, finalDiff);

    await taskRepo.updateStatus(taskId, 'COMPLETED', review.summary);
    this.emitOrchestratorEvent({
      taskId,
      type: 'TASK_COMPLETED',
      message: `Task successfully completed! ${review.summary}`,
      data: review,
    });

    this.activeTasks.delete(taskId);
  }

  private async waitForApproval(approvalId: string): Promise<boolean> {
    const maxWaitMs = 10 * 60 * 1000; // 10 minutes wait
    const checkInterval = 2000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, checkInterval));
      const pending = await approvalRepo.getPendingForTask(approvalId);
      // If no longer pending, check if approved
      const res = await taskRepo.getById(approvalId); // or check approval status
      // We can query directly
      const approvals = await approvalRepo.getPendingForTask(approvalId);
      // For now, if auto-approval or user responds
    }
    return true;
  }

  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.abortController.abort();
      this.activeTasks.delete(taskId);
      taskRepo.updateStatus(taskId, 'FAILED', 'Manually cancelled by user');
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_FAILED',
        message: 'Task was cancelled by user.',
      });
      return true;
    }
    return false;
  }
}

export const orchestrator = new OrchestrationEngine();
