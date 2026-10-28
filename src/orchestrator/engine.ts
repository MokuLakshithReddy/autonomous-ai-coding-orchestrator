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
  eventRepo,
  checkpointRepo,
  type TaskRecord,
  type StepRecord,
} from '../db/index.js';
import { TaskStateMachine, type TaskState } from '../core/state-machine.js';
import { SecurityPolicyEngine } from '../security/policy.js';
import { config } from '../config/index.js';

export interface OrchestratorEvent {
  id: string;
  taskId: string;
  stepId?: string;
  type: string;
  fromState?: TaskState;
  toState?: TaskState;
  message: string;
  data?: any;
  timestamp: string;
}

export class OrchestrationEngine extends EventEmitter {
  private activeTasks = new Map<
    string,
    {
      abortController: AbortController;
      stateMachine: TaskStateMachine;
      startedAt: number;
    }
  >();

  constructor() {
    super();
  }

  emitOrchestratorEvent(event: Omit<OrchestratorEvent, 'id' | 'timestamp'>): void {
    const fullEvent: OrchestratorEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Append to durable SQLite event ledger
    eventRepo.append({
      id: fullEvent.id,
      taskId: fullEvent.taskId,
      eventType: fullEvent.type,
      fromState: fullEvent.fromState,
      toState: fullEvent.toState,
      message: fullEvent.message,
      dataJson: fullEvent.data ? JSON.stringify(fullEvent.data) : undefined,
      timestamp: fullEvent.timestamp,
    }).catch((err) => console.error('Failed to append event to ledger:', err));

    this.emit('event', fullEvent);
  }

  private async transitionTaskState(
    taskId: string,
    stateMachine: TaskStateMachine,
    targetState: TaskState,
    reason: string,
    summary?: string
  ): Promise<void> {
    const transition = stateMachine.transition(targetState, reason);
    await taskRepo.updateStatus(taskId, targetState, summary);

    this.emitOrchestratorEvent({
      taskId,
      type: `STATE_${targetState.toUpperCase()}`,
      fromState: transition.from,
      toState: transition.to,
      message: `State transition: ${transition.from} -> ${transition.to} (${reason})`,
    });
  }

  async runTask(params: {
    prompt: string;
    workspacePath: string;
    title?: string;
    maxRetries?: number;
    customAgent?: CodingAgent;
  }): Promise<TaskRecord> {
    // Assert workspace path security
    const resolvedWorkspace = SecurityPolicyEngine.assertPathContainment(params.workspacePath, params.workspacePath);

    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxRetries = params.maxRetries ?? config.maxRetryBudget;
    const title = params.title || params.prompt.slice(0, 60);

    const stateMachine = new TaskStateMachine('queued');

    const task: TaskRecord = {
      id: taskId,
      title,
      prompt: params.prompt,
      workspacePath: resolvedWorkspace,
      status: stateMachine.getState(),
      retryCount: 0,
      maxRetries,
      attemptId,
      createdAt: now,
      updatedAt: now,
    };

    await taskRepo.create(task);

    this.emitOrchestratorEvent({
      taskId,
      type: 'TASK_CREATED',
      toState: 'queued',
      message: `Task registered in durable ledger: "${title}"`,
      data: task,
    });

    const abortController = new AbortController();
    this.activeTasks.set(taskId, {
      abortController,
      stateMachine,
      startedAt: Date.now(),
    });

    // Run execution lifecycle asynchronously
    this.executeTaskLifecycle(taskId, attemptId, params).catch(async (err) => {
      console.error(`Unhandled error in task ${taskId}:`, err);
      const active = this.activeTasks.get(taskId);
      if (active && !active.stateMachine.isTerminal()) {
        try {
          await this.transitionTaskState(
            taskId,
            active.stateMachine,
            'failed',
            `Internal failure: ${err.message}`,
            err.message
          );
        } catch {}
      }
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_FAILED',
        toState: 'failed',
        message: `Task failed with error: ${err.message}`,
      });
      this.activeTasks.delete(taskId);
    });

    return task;
  }

  private async executeTaskLifecycle(
    taskId: string,
    attemptId: string,
    params: {
      prompt: string;
      workspacePath: string;
      maxRetries?: number;
      customAgent?: CodingAgent;
    }
  ): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (!active) return;
    const { stateMachine, abortController, startedAt } = active;

    const inspector = new RepoInspector(params.workspacePath);
    const brain = new LLMBrain();
    const verifier = new IndependentVerifier(params.workspacePath);
    const agent = params.customAgent || new BuiltInAutonomousAgent(params.workspacePath);
    const maxRetries = params.maxRetries ?? config.maxRetryBudget;

    // Check execution budget limit (default max 30 minutes total)
    const maxTotalDurationMs = config.stepTimeoutSeconds * 10 * 1000;

    const checkBudgetOrAbort = (): boolean => {
      if (abortController.signal.aborted) {
        throw new Error('Task was cancelled by user request.');
      }
      if (Date.now() - startedAt > maxTotalDurationMs) {
        throw new Error(`Execution budget exceeded: Total duration exceeded ${maxTotalDurationMs / 1000}s limit.`);
      }
      return true;
    };

    // 1. Discovering Phase: Repo Baseline & Ecosystem
    await this.transitionTaskState(taskId, stateMachine, 'discovering', 'Inspecting repository and capturing baseline');
    const baseline = await inspector.captureBaseline();
    const repoMeta = await inspector.inspect();

    if (baseline) {
      await checkpointRepo.record({
        id: crypto.randomUUID(),
        taskId,
        attemptId,
        baseCommit: baseline.baseCommit,
        branchName: baseline.branch,
        snapshotDescription: `Initial repository baseline on branch ${baseline.branch}`,
        createdAt: new Date().toISOString(),
      });
    }

    this.emitOrchestratorEvent({
      taskId,
      type: 'REPO_INSPECTED',
      message: `Repository discovered: ${repoMeta.ecosystems.join(', ')} ecosystem. Clean: ${baseline?.isClean ?? 'N/A'}`,
      data: { repoMeta, baseline },
    });

    checkBudgetOrAbort();

    // 2. Planning Phase
    await this.transitionTaskState(taskId, stateMachine, 'planning', 'Formulating structured execution plan');
    const plan: ExecutionPlan = await brain.generatePlan(params.prompt, repoMeta);
    await taskRepo.updatePlan(taskId, JSON.stringify(plan));

    this.emitOrchestratorEvent({
      taskId,
      type: 'PLAN_GENERATED',
      message: `Plan formulated with ${plan.steps.length} milestones and ${plan.acceptanceCriteria.length} criteria.`,
      data: plan,
    });

    // Create DB records for plan steps
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

    // Transition to Ready
    await this.transitionTaskState(taskId, stateMachine, 'ready', 'Plan approved and ready for execution');

    // 3. Step Execution Loop
    for (let i = 0; i < plan.steps.length; i++) {
      checkBudgetOrAbort();

      const step = plan.steps[i];
      const stepRec = stepRecords[i];
      const targetFiles = step.targetFiles || [];

      // Security & Authorization Gate
      const policy = SecurityPolicyEngine.evaluateActionRisk(step.title, step.instruction);
      const isSensitive = step.isSensitive || policy.requiresApproval;

      if (isSensitive) {
        await this.transitionTaskState(
          taskId,
          stateMachine,
          'awaiting_approval',
          `Sensitive step requires human authorization: ${step.title}`
        );

        const approvalId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes expiry

        await approvalRepo.create({
          id: approvalId,
          taskId,
          stepId: stepRec.id,
          actionType: policy.riskLevel,
          targetResource: targetFiles.join(', ') || 'workspace',
          parametersJson: JSON.stringify({ instruction: step.instruction }),
          details: policy.reason || `Approval required for step "${step.title}"`,
          status: 'PENDING',
          expiresAt,
          createdAt: new Date().toISOString(),
        });

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'APPROVAL_REQUIRED',
          message: `Approval requested: ${step.title} (${policy.riskLevel})`,
          data: { approvalId, step, policy, expiresAt },
        });

        // Fail-Closed: strictly wait for explicit operator approval
        const isApproved = await this.waitForApproval(approvalId);

        if (!isApproved) {
          await stepRepo.update(stepRec.id, { status: 'SKIPPED' });
          this.emitOrchestratorEvent({
            taskId,
            stepId: stepRec.id,
            type: 'APPROVAL_RESOLVED',
            message: `Step "${step.title}" was not approved (rejected or expired). Skipping step.`,
          });
          continue;
        }

        // Return to ready before executing
        await this.transitionTaskState(taskId, stateMachine, 'ready', 'Approval granted by operator');
      }

      await this.transitionTaskState(taskId, stateMachine, 'executing', `Executing step ${step.index}: "${step.title}"`);
      await stepRepo.update(stepRec.id, { status: 'RUNNING' });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_STARTED',
        message: `Step ${step.index}/${plan.steps.length}: "${step.title}" started.`,
        data: step,
      });

      // Safe targeted checkpoint before executing step
      const preStepCommit = await inspector.createTaskCheckpoint(
        targetFiles,
        `pre-step-${step.index}: ${step.title}`
      );

      if (preStepCommit) {
        await checkpointRepo.record({
          id: crypto.randomUUID(),
          taskId,
          attemptId,
          stepId: stepRec.id,
          commitHash: preStepCommit,
          snapshotDescription: `Pre-step snapshot: ${step.title}`,
          createdAt: new Date().toISOString(),
        });
      }

      // Execute Step with Agent
      const stepStartTime = Date.now();
      let currentInstruction = step.instruction;
      let executionResult = await agent.executeStep(currentInstruction, targetFiles);
      const stepDurationMs = Date.now() - stepStartTime;

      await stepRepo.update(stepRec.id, {
        outputLog: executionResult.logs,
        toolsUsedJson: JSON.stringify(executionResult.toolsUsed),
        diffSummary: executionResult.diffSummary,
        exitCode: executionResult.exitCode,
        durationMs: stepDurationMs,
      });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_EXECUTED',
        message: `Agent execution finished for "${step.title}". Triggering independent verification.`,
        data: executionResult,
      });

      // 4. Verification and Self-Repair Loop
      await this.transitionTaskState(taskId, stateMachine, 'verifying', `Verifying step "${step.title}"`);

      let verification = await verifier.verify(repoMeta, plan.acceptanceCriteria, step.verificationCommand);
      let stepRetries = 0;

      while (!verification.overallPassed && stepRetries < maxRetries) {
        checkBudgetOrAbort();
        stepRetries++;
        await taskRepo.incrementRetry(taskId);

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'VERIFICATION_FAILED',
          message: `Verification check failed on step "${step.title}" (Attempt ${stepRetries}/${maxRetries}).`,
          data: verification,
        });

        await verificationRepo.record({
          id: crypto.randomUUID(),
          taskId,
          stepId: stepRec.id,
          status: 'FAILED',
          buildStatus: verification.buildCheck.status as any,
          testStatus: verification.testCheck.status as any,
          lintStatus: verification.lintCheck.status as any,
          diffInspection: verification.diffAudit.summary,
          detailsJson: JSON.stringify(verification),
          diagnostics: verification.diagnostics,
          createdAt: new Date().toISOString(),
        });

        // Diagnose with LLM Brain
        await this.transitionTaskState(taskId, stateMachine, 'diagnosing', `Diagnosing failure for "${step.title}"`);

        const recentDiff = await inspector.getDiff();
        const diagnostic = await brain.diagnoseFailure(
          step,
          executionResult.logs,
          verification.diagnostics,
          recentDiff
        );

        if (!diagnostic.shouldRetry) {
          await this.transitionTaskState(
            taskId,
            stateMachine,
            'blocked',
            `Unrecoverable blocker identified: ${diagnostic.rootCause}`,
            diagnostic.rootCause
          );
          this.emitOrchestratorEvent({
            taskId,
            stepId: stepRec.id,
            type: 'TASK_BLOCKED',
            message: `Task blocked: ${diagnostic.rootCause}`,
            data: diagnostic,
          });
          return;
        }

        // Repair Attempt
        await this.transitionTaskState(taskId, stateMachine, 'repairing', `Attempting self-repair (Attempt ${stepRetries})`);

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'REPAIR_ATTEMPT',
          message: `Dispatching corrective repair for "${step.title}": ${diagnostic.correctiveInstructions}`,
          data: diagnostic,
        });

        currentInstruction = `${step.instruction}\n\nCORRECTIVE REPAIR INSTRUCTIONS:\n${diagnostic.correctiveInstructions}`;
        executionResult = await agent.executeStep(currentInstruction, targetFiles);

        // Reverification
        await this.transitionTaskState(taskId, stateMachine, 'verifying', `Re-verifying step "${step.title}" after repair`);
        verification = await verifier.verify(repoMeta, plan.acceptanceCriteria, step.verificationCommand);
      }

      // Check if step permanently failed
      if (!verification.overallPassed) {
        await stepRepo.update(stepRec.id, { status: 'FAILED' });

        // Safe rollback of task-owned files if checkpoint exists
        if (preStepCommit && targetFiles.length > 0) {
          await inspector.restoreTaskFiles(targetFiles, preStepCommit);
        }

        await this.transitionTaskState(
          taskId,
          stateMachine,
          'failed',
          `Exhausted retry budget (${maxRetries} attempts) on step "${step.title}".`,
          `Failed on step: ${step.title}. ${verification.blockingReasons.join('; ')}`
        );

        this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'TASK_FAILED',
          message: `Task failed: Verification could not be satisfied within budget (${maxRetries} retries).`,
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
        buildStatus: verification.buildCheck.status as any,
        testStatus: verification.testCheck.status as any,
        lintStatus: verification.lintCheck.status as any,
        diffInspection: verification.diffAudit.summary,
        detailsJson: JSON.stringify(verification),
        createdAt: new Date().toISOString(),
      });

      this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'VERIFICATION_PASSED',
        message: `Step "${step.title}" independently verified!`,
        data: verification,
      });

      // Post-step checkpoint
      const postStepCommit = await inspector.createTaskCheckpoint(
        targetFiles,
        `post-step-${step.index}: ${step.title}`
      );

      if (postStepCommit) {
        await checkpointRepo.record({
          id: crypto.randomUUID(),
          taskId,
          attemptId,
          stepId: stepRec.id,
          commitHash: postStepCommit,
          snapshotDescription: `Post-step checkpoint: ${step.title}`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // 5. Final Completion Gate
    // Re-run final comprehensive verification across entire repository changes
    await this.transitionTaskState(taskId, stateMachine, 'verifying', 'Executing final completion verification gate');
    const finalVerification = await verifier.verify(repoMeta, plan.acceptanceCriteria);
    const finalDiff = await inspector.getDiffAgainstBase();

    const verifications = await verificationRepo.listForTask(taskId);
    const verifSummaries = verifications.map(
      (v) => `[${v.status}] Build: ${v.buildStatus}, Test: ${v.testStatus}, Diff: ${v.diffInspection}`
    );

    const review = await brain.reviewOutcome(
      params.prompt,
      plan,
      verifSummaries,
      finalDiff,
      !finalVerification.canDeclareComplete
    );

    // Truthful Completion Gate: Distinguish completed vs partially_completed vs needs_human_review vs failed
    if (finalVerification.canDeclareComplete && review.isComplete) {
      await this.transitionTaskState(taskId, stateMachine, 'completed', 'All requirements verified', review.summary);
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_COMPLETED',
        message: `Task successfully verified and completed: ${review.summary}`,
        data: { review, finalVerification },
      });
    } else if (finalVerification.overallPassed && !review.isComplete) {
      // Passes compilation/tests but LLM reviewer flagged unaddressed requirements
      await this.transitionTaskState(
        taskId,
        stateMachine,
        'needs_human_review',
        'Verification passed but reviewer identified pending items',
        review.summary
      );
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_NEEDS_REVIEW',
        message: `Task requires human review: ${review.summary}`,
        data: { review, finalVerification },
      });
    } else {
      // Unresolved checks or missing acceptance criteria
      await this.transitionTaskState(
        taskId,
        stateMachine,
        'partially_completed',
        `Verification incomplete: ${finalVerification.blockingReasons.join('; ')}`,
        review.summary
      );
      this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_PARTIALLY_COMPLETED',
        message: `Task partially completed with unverified criteria: ${finalVerification.blockingReasons.join(', ')}`,
        data: { review, finalVerification },
      });
    }

    this.activeTasks.delete(taskId);
  }

  /**
   * Fail-Closed Approval Waiter:
   * Looks up specific approval by approvalId. Never treats timeout or absence as approval!
   */
  private async waitForApproval(approvalId: string): Promise<boolean> {
    const maxWaitMs = 10 * 60 * 1000; // 10 minutes wait limit
    const checkInterval = 1500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, checkInterval));

      const record = await approvalRepo.getById(approvalId);
      if (!record) return false;

      if (record.status === 'APPROVED') {
        return true;
      }
      if (record.status === 'REJECTED' || record.status === 'CANCELLED') {
        return false;
      }
    }

    // Timeout expired: Mark approval EXPIRED and fail closed
    await approvalRepo.respond(approvalId, 'EXPIRED', 'system_timeout');
    return false;
  }

  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.abortController.abort();
      if (!task.stateMachine.isTerminal()) {
        this.transitionTaskState(
          taskId,
          task.stateMachine,
          'cancelling',
          'User triggered task cancellation'
        ).then(() => {
          this.transitionTaskState(
            taskId,
            task.stateMachine,
            'cancelled',
            'Task cancelled and processes terminated'
          );
        });
      }
      this.activeTasks.delete(taskId);
      return true;
    }
    return false;
  }
}

export const orchestrator = new OrchestrationEngine();
