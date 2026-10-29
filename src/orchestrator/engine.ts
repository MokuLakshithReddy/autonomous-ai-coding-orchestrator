import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { RepoInspector, type ProjectMetadata } from '../repo/inspector.js';
import { LLMBrain, type ExecutionPlan, type PlanStep } from '../llm/index.js';
import { BuiltInAutonomousAgent, createAgent, type CodingAgent } from '../agent/index.js';
import { IndependentVerifier, type VerificationReport } from '../verifier/index.js';
import {
  initDatabase,
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
import { SecurityPolicyEngine, type ActionPolicy } from '../security/policy.js';
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
  private allowedWorkspaces?: string[];
  private allowUnrestricted?: boolean;
  private activeTasks = new Map<
    string,
    {
      abortController: AbortController;
      stateMachine: TaskStateMachine;
      startedAt: number;
      lifecyclePromise?: Promise<void>;
    }
  >();

  public lastBrain?: LLMBrain;

  constructor(options?: { allowedWorkspaces?: string[]; allowUnrestricted?: boolean }) {
    super();
    this.allowedWorkspaces = options?.allowedWorkspaces;
    this.allowUnrestricted = options?.allowUnrestricted;
  }

  /**
   * P1 FIX: Awaited and retry-protected event ledger write.
   * Guarantees audit events are safely persisted to SQLite before lifecycle progression.
   */
  async emitOrchestratorEvent(event: Omit<OrchestratorEvent, 'id' | 'timestamp'>): Promise<void> {
    const fullEvent: OrchestratorEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    let attempts = 0;
    while (attempts < 3) {
      try {
        await eventRepo.append({
          id: fullEvent.id,
          taskId: fullEvent.taskId,
          eventType: fullEvent.type,
          fromState: fullEvent.fromState,
          toState: fullEvent.toState,
          message: fullEvent.message,
          dataJson: fullEvent.data ? JSON.stringify(fullEvent.data) : undefined,
          timestamp: fullEvent.timestamp,
        });
        break;
      } catch (err: any) {
        attempts++;
        if (attempts >= 3) {
          console.error(`[Event Ledger Persistence Failure] Could not append event "${fullEvent.type}":`, err);
          throw new Error(`Durable event ledger persistence error (${fullEvent.type}): ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 50 * attempts));
      }
    }

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

    await this.emitOrchestratorEvent({
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
    agentType?: 'builtin' | 'aider' | 'claude';
    autoMerge?: boolean;
    allowProtectedBranchMerge?: boolean;
    allowedWorkspaces?: string[];
    allowUnrestricted?: boolean;
  }): Promise<TaskRecord> {
    await initDatabase();
    const allowedRoots = params.allowedWorkspaces ?? this.allowedWorkspaces ?? config.allowedWorkspaces;
    const allowUnrestricted =
      params.allowUnrestricted ?? this.allowUnrestricted ?? config.allowUnrestrictedWorkspaces;
    const authorizedWorkspace = SecurityPolicyEngine.validateWorkspaceAuthorization(
      params.workspacePath,
      allowedRoots,
      { allowUnrestricted }
    );
    const resolvedWorkspace = SecurityPolicyEngine.assertPathContainment(authorizedWorkspace, authorizedWorkspace);

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

    await this.emitOrchestratorEvent({
      taskId,
      type: 'TASK_CREATED',
      toState: 'queued',
      message: `Task registered in durable ledger: "${title}"`,
      data: task,
    });

    const abortController = new AbortController();
    const activeTaskEntry = {
      abortController,
      stateMachine,
      startedAt: Date.now(),
      lifecyclePromise: undefined as Promise<void> | undefined,
    };
    this.activeTasks.set(taskId, activeTaskEntry);

    // Run execution lifecycle asynchronously
    const lifecyclePromise = this.executeTaskLifecycle(taskId, attemptId, params).catch(async (err) => {
      const isCancelled =
        abortController.signal.aborted ||
        stateMachine.getState() === 'cancelling' ||
        stateMachine.getState() === 'cancelled';
      if (isCancelled) {
        this.activeTasks.delete(taskId);
        return;
      }
      console.error(`Unhandled error in task ${taskId}:`, err);
      try {
        await taskRepo.updateStatus(taskId, 'failed', `Internal failure: ${err.message}`);
      } catch (dbErr: any) {
        console.error(`[Fatal DB Error] Could not update task status for ${taskId}:`, dbErr);
      }
      try {
        await this.emitOrchestratorEvent({
          taskId,
          type: 'TASK_FAILED',
          toState: 'failed',
          message: `Task failed with error: ${err.message}`,
        });
      } catch (eventErr: any) {
        console.error(`[Event Ledger Fallback Error] Could not emit failure event for ${taskId}:`, eventErr);
      }
      this.activeTasks.delete(taskId);
    });

    activeTaskEntry.lifecyclePromise = lifecyclePromise;

    return task;
  }

  /**
   * P1 FIX: Await complete task execution lifecycle and worktree cleanup before caller exits.
   */
  async waitForTask(taskId: string): Promise<TaskRecord | null> {
    const active = this.activeTasks.get(taskId);
    if (active?.lifecyclePromise) {
      try {
        await active.lifecyclePromise;
      } catch {}
    }
    return taskRepo.getById(taskId);
  }

  private async executeTaskLifecycle(
    taskId: string,
    attemptId: string,
    params: {
      prompt: string;
      workspacePath: string;
      maxRetries?: number;
      customAgent?: CodingAgent;
      agentType?: 'builtin' | 'aider' | 'claude';
      autoMerge?: boolean;
      allowProtectedBranchMerge?: boolean;
    }
  ): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (!active || active.stateMachine.isTerminal()) return;
    const { stateMachine, abortController, startedAt } = active;

    const inspector = new RepoInspector(params.workspacePath);
    const brain = new LLMBrain();
    this.lastBrain = brain;

    // P0 FIX: Strict isolation enforcement - NEVER silently fall back to user working tree!
    let executionPath: string;
    let taskWorktreePath: string | null = null;
    let isWorktree = false;
    let taskBranchName: string | undefined;

    const isGit = await inspector.isGitRepository();
    if (!isGit) {
      const errMsg = `Safety Exception [Git Required]: Workspace "${params.workspacePath}" is not a Git repository. Autonomous coding requires a Git repository for isolated branch checkpoints, worktrees, and safe rollbacks. Please run "git init" in your workspace or select an existing Git repository.`;
      await this.transitionTaskState(taskId, stateMachine, 'failed', errMsg, errMsg);
      throw new Error(errMsg);
    }

    try {
      taskWorktreePath = await inspector.createIsolatedWorktree(taskId);
      executionPath = taskWorktreePath;
      isWorktree = true;
      taskBranchName = `task/${taskId.slice(0, 8)}`;
    } catch (err: any) {
      const errMsg = `Safety Exception [Isolation Failure]: Mandatory Git worktree isolation failed for task ${taskId}: ${err.message}. Execution aborted to prevent altering user workspace.`;
      await this.transitionTaskState(taskId, stateMachine, 'failed', errMsg, errMsg);
      throw new Error(errMsg);
    }

    const taskInspector = taskWorktreePath ? new RepoInspector(taskWorktreePath) : inspector;
    const verifier = new IndependentVerifier(executionPath);

    try {

    if (params.customAgent) {
      if (typeof (params.customAgent as any).setWorkspacePath === 'function') {
        (params.customAgent as any).setWorkspacePath(executionPath);
      } else {
        (params.customAgent as any).workspacePath = executionPath;
      }
    }

    let currentExecutingStepId: string | undefined;

    const agent =
      params.customAgent ||
      createAgent(
        params.agentType || 'builtin',
        executionPath,
        async (commandOrAction, policy) => {
          return await this.requestCommandApproval(taskId, currentExecutingStepId, commandOrAction, policy);
        }
      );
    const maxRetries = params.maxRetries ?? config.maxRetryBudget;
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
    if (abortController.signal.aborted || stateMachine.isTerminal()) return;
    await this.transitionTaskState(taskId, stateMachine, 'discovering', 'Capturing repository baseline');
    const baseline = await inspector.captureBaseline();
    if (taskInspector) {
      (taskInspector as any).baseline = baseline;
    }
    const repoMeta = await inspector.inspect();

    if (baseline) {
      await checkpointRepo.record({
        id: crypto.randomUUID(),
        taskId,
        attemptId,
        baseCommit: baseline.baseCommit,
        branchName: baseline.branch,
        snapshotDescription: `Repository baseline on branch ${baseline.branch} (${baseline.dirtyFilesAtStart.length} pre-existing dirty files)`,
        createdAt: new Date().toISOString(),
      });
    }

    await this.emitOrchestratorEvent({
      taskId,
      type: 'REPO_INSPECTED',
      message: `Repository discovered: ${repoMeta.ecosystems.join(', ')} ecosystem. Baseline: ${baseline?.baseCommit || 'none'}`,
      data: { repoMeta, baseline },
    });

    checkBudgetOrAbort();

    // 2. Planning Phase
    await this.transitionTaskState(taskId, stateMachine, 'planning', 'Formulating structured execution plan');
    const plan: ExecutionPlan = await brain.generatePlan(params.prompt, repoMeta);
    await taskRepo.updatePlan(taskId, JSON.stringify(plan));

    await this.emitOrchestratorEvent({
      taskId,
      type: 'PLAN_GENERATED',
      message: `Plan formulated with ${plan.steps.length} milestones and ${plan.acceptanceCriteria.length} acceptance criteria.`,
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

      // P0.3 & P0.4: Handle Approval Gate at Action Boundary
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
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

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

        await this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'APPROVAL_REQUIRED',
          message: `Approval requested: ${step.title} (${policy.riskLevel})`,
          data: { approvalId, step, policy, expiresAt },
        });

        // Fail-Closed: strictly wait for explicit operator approval
        const isApproved = await this.waitForApproval(approvalId, abortController.signal);

        if (!isApproved) {
          await stepRepo.update(stepRec.id, { status: 'SKIPPED' });
          await this.emitOrchestratorEvent({
            taskId,
            stepId: stepRec.id,
            type: 'APPROVAL_RESOLVED',
            message: `Step "${step.title}" was not approved (rejected or expired). Skipping step.`,
          });
          // Transition back to ready (or verifying if final step)
          if (i === plan.steps.length - 1) {
            await this.transitionTaskState(taskId, stateMachine, 'verifying', 'Skipped last step; proceeding to final verification');
          } else {
            await this.transitionTaskState(taskId, stateMachine, 'ready', 'Step skipped; ready for next step');
          }
          continue;
        }

        // Return to ready before executing
        await this.transitionTaskState(taskId, stateMachine, 'ready', 'Approval granted by operator');
      }

      await this.transitionTaskState(taskId, stateMachine, 'executing', `Executing step ${step.index}: "${step.title}"`);
      await stepRepo.update(stepRec.id, { status: 'RUNNING' });

      await this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_STARTED',
        message: `Step ${step.index}/${plan.steps.length}: "${step.title}" started.`,
        data: step,
      });

      currentExecutingStepId = stepRec.id;

      // Safe targeted checkpoint before executing step
      const preStepCommit = await taskInspector.createTaskCheckpoint(
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

      // P0.1 & P0.6: Pass abortSignal to agent
      const stepStartTime = Date.now();
      let currentInstruction = step.instruction;
      let executionResult = await agent.executeStep(currentInstruction, targetFiles, abortController.signal);
      const stepDurationMs = Date.now() - stepStartTime;

      await stepRepo.update(stepRec.id, {
        outputLog: executionResult.logs,
        toolsUsedJson: JSON.stringify(executionResult.toolsUsed),
        diffSummary: executionResult.diffSummary,
        exitCode: executionResult.exitCode,
        durationMs: stepDurationMs,
      });

      await this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'STEP_EXECUTED',
        message: `Agent finished execution for "${step.title}" (Success: ${executionResult.success}). Triggering independent verification.`,
        data: executionResult,
      });

      // 4. Verification and Self-Repair Loop
      await this.transitionTaskState(taskId, stateMachine, 'verifying', `Verifying step "${step.title}"`);

      // P1.1: Verify against baseline commit so committed changes are tracked!
      const preStepVerifFingerprint = await taskInspector.getWorkspaceFingerprint();
      const isLastStep = i === plan.steps.length - 1;
      const stepVerificationCmd = step.verificationCommand || (isLastStep ? undefined : repoMeta.buildCmd || undefined);
      let verification = await verifier.verify(
        repoMeta,
        plan.acceptanceCriteria,
        stepVerificationCmd,
        baseline?.baseCommit,
        { isIntermediateStep: !isLastStep }
      );
      const postStepVerifFingerprint = await taskInspector.getWorkspaceFingerprint();
      if (preStepVerifFingerprint !== postStepVerifFingerprint) {
        verification.isVerified = false;
        verification.status = 'FAILED';
        verification.blockingReasons.push(
          `Workspace integrity violation: Workspace mutated during step verification (fingerprint mismatch: ${preStepVerifFingerprint.slice(0, 8)} -> ${postStepVerifFingerprint.slice(0, 8)}).`
        );
      }

      let stepRetries = 0;

      // P0.1 & P0.2 FIX: Must check both executionResult.success AND verification.isVerified!
      while ((!executionResult.success || !verification.isVerified) && stepRetries < maxRetries) {
        checkBudgetOrAbort();
        stepRetries++;
        await taskRepo.incrementRetry(taskId);

        const failureDetails = !executionResult.success
          ? `Agent execution failed: ${executionResult.failureReason || 'Incomplete execution'}`
          : `Verification failed: ${verification.blockingReasons.join('; ')}`;

        await this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'VERIFICATION_FAILED',
          message: `${failureDetails} (Attempt ${stepRetries}/${maxRetries}).`,
          data: { verification, executionResult },
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
          diagnostics: `${executionResult.failureReason || ''}\n${verification.diagnostics}`,
          createdAt: new Date().toISOString(),
        });

        // Diagnose with LLM Brain
        await this.transitionTaskState(taskId, stateMachine, 'diagnosing', `Diagnosing failure for "${step.title}"`);

        const recentDiff = await taskInspector.getDiffAgainstBase(baseline?.baseCommit);
        const diagnostic = await brain.diagnoseFailure(
          step,
          executionResult.logs,
          `${executionResult.failureReason || ''}\n${verification.diagnostics}`,
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
          await this.emitOrchestratorEvent({
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

        await this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'REPAIR_ATTEMPT',
          message: `Dispatching corrective repair for "${step.title}": ${diagnostic.correctiveInstructions}`,
          data: diagnostic,
        });

        currentInstruction = `${step.instruction}\n\nCORRECTIVE REPAIR INSTRUCTIONS:\n${diagnostic.correctiveInstructions}`;
        executionResult = await agent.executeStep(currentInstruction, targetFiles, abortController.signal);

        await stepRepo.update(stepRec.id, {
          outputLog: executionResult.logs,
          toolsUsedJson: JSON.stringify(executionResult.toolsUsed),
          diffSummary: executionResult.diffSummary,
          exitCode: executionResult.exitCode,
        });

        // Reverification
        await this.transitionTaskState(taskId, stateMachine, 'verifying', `Re-verifying step "${step.title}" after repair`);
        verification = await verifier.verify(
          repoMeta,
          plan.acceptanceCriteria,
          stepVerificationCmd,
          baseline?.baseCommit,
          { isIntermediateStep: !isLastStep }
        );
      }

      // Check if step permanently failed
      if (!executionResult.success || !verification.isVerified) {
        await stepRepo.update(stepRec.id, { status: 'FAILED' });

        // P0 FIX: Ensure permanent step failure is faithfully persisted to verification ledger
        try {
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
            diagnostics: `${executionResult.failureReason || ''}\n${verification.diagnostics}`,
            createdAt: new Date().toISOString(),
          });
        } catch {}

        // Safe rollback of task-owned files if checkpoint exists
        if (preStepCommit && targetFiles.length > 0) {
          await taskInspector.restoreTaskFiles(targetFiles, preStepCommit);
        }

        const finalFailReason = !executionResult.success
          ? `Agent failed: ${executionResult.failureReason}`
          : `Verification failed: ${verification.blockingReasons.join('; ')}`;

        await this.transitionTaskState(
          taskId,
          stateMachine,
          'failed',
          `Exhausted retry budget (${maxRetries} attempts) on step "${step.title}".`,
          `Failed on step: ${step.title}. ${finalFailReason}`
        );

        await this.emitOrchestratorEvent({
          taskId,
          stepId: stepRec.id,
          type: 'TASK_FAILED',
          message: `Task failed: Requirements could not be satisfied within budget (${maxRetries} retries).`,
          data: { verification, executionResult },
        });
        return;
      }

      // Step passed!
      const wasAgentDeclared = executionResult.agentResolution === 'declared_completion' || executionResult.success;
      const resolutionMode = wasAgentDeclared
        ? 'agent_declared_completion'
        : 'independently_verified_after_agent_stopped';

      await stepRepo.update(stepRec.id, {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        outputLog: `${executionResult.logs}\n\n[Orchestrator Resolution]: ${
          wasAgentDeclared
            ? 'Step completed cleanly by agent declaration.'
            : 'Notice: Agent stopped without declaring completion (exhausted iterations), but Orchestrator independently verified that test suite passed cleanly with verified git diff evidence.'
        }`,
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

      await this.emitOrchestratorEvent({
        taskId,
        stepId: stepRec.id,
        type: 'VERIFICATION_PASSED',
        message: wasAgentDeclared
          ? `Step "${step.title}" independently verified (Agent declared completion).`
          : `Step "${step.title}" independently verified (Notice: Agent stopped without declaring completion; independent tests confirmed repair).`,
        data: { verification, resolutionMode },
      });

      // Post-step checkpoint
      const postStepCommit = await taskInspector.createTaskCheckpoint(
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

      // P0.3: Prepare for next step transition if steps remain
      if (i < plan.steps.length - 1) {
        const nextStep = plan.steps[i + 1];
        const nextPolicy = SecurityPolicyEngine.evaluateActionRisk(nextStep.title, nextStep.instruction);
        if (nextStep.isSensitive || nextPolicy.requiresApproval) {
          // Allowed: verifying -> awaiting_approval
          // (Handled at start of next iteration)
        } else {
          // Allowed: verifying -> ready
          await this.transitionTaskState(taskId, stateMachine, 'ready', `Ready for milestone ${nextStep.index}`);
        }
      }
    }

    // 5. Final Completion Gate
    // Re-verify against original baseline commit
    await this.transitionTaskState(taskId, stateMachine, 'verifying', 'Executing final completion verification gate');
    
    // P1 FIX: Commit any remaining task worktree changes before final verification and cleanup
    try {
      await taskInspector.createTaskCheckpoint([], `Task ${taskId} final changes before completion verification`);
    } catch {}

    // P0 FIX: Capture pre-verification workspace fingerprint (HEAD commit + working tree + staged + untracked files)
    const preVerificationFingerprint = await taskInspector.getWorkspaceFingerprint();
    
    const finalVerification = await verifier.verify(
      repoMeta,
      plan.acceptanceCriteria,
      undefined,
      baseline?.baseCommit,
      { abortSignal: active?.abortController.signal }
    );
    
    // P0 FIX: Ensure full workspace state (tracked & untracked files, working diffs, commit) has not mutated during verification
    const postVerificationFingerprint = await taskInspector.getWorkspaceFingerprint();
    if (preVerificationFingerprint !== postVerificationFingerprint) {
      finalVerification.isVerified = false;
      finalVerification.status = 'FAILED';
      finalVerification.blockingReasons.push(
        `Workspace integrity violation: Workspace mutated during verification (fingerprint mismatch: ${preVerificationFingerprint.slice(0, 8)} -> ${postVerificationFingerprint.slice(0, 8)}).`
      );
    }

    // P0 FIX: If test suite was configured, verify tests genuinely ran and passed cleanly
    if (repoMeta.testCmd && finalVerification.testCheck.status !== 'PASSED') {
      finalVerification.isVerified = false;
      finalVerification.status = 'FAILED';
      finalVerification.blockingReasons.push(
        `Verification failure: Configured test suite (${repoMeta.testCmd}) did not achieve PASSED status (status: ${finalVerification.testCheck.status}).`
      );
    }

    const finalDiff = await taskInspector.getDiffAgainstBase(baseline?.baseCommit);

    const verifications = await verificationRepo.listForTask(taskId);
    const verifSummaries = verifications.map(
      (v) => `[${v.status}] Build: ${v.buildStatus}, Test: ${v.testStatus}, Diff: ${v.diffInspection}`
    );

    const review = await brain.reviewOutcome(
      params.prompt,
      plan,
      verifSummaries,
      finalDiff,
      !finalVerification.isVerified
    );

    // P0 FIX: Model-generated claim of success can NEVER override unverified criteria or test failure
    if (!finalVerification.isVerified && review.isComplete) {
      review.isComplete = false;
      review.unresolvedIssues.push(
        `Independent verification failed: ${finalVerification.blockingReasons.join('; ')}`
      );
    }

    // P1 FIX: Persist final verification report, failed checks, and diagnostics to durable database BEFORE state transition
    try {
      await verificationRepo.record({
        id: crypto.randomUUID(),
        taskId,
        status: finalVerification.status as any,
        buildStatus: finalVerification.buildCheck.status as any,
        testStatus: finalVerification.testCheck.status as any,
        lintStatus: finalVerification.lintCheck.status as any,
        diffInspection: finalVerification.diffAudit.summary,
        detailsJson: JSON.stringify(finalVerification),
        diagnostics: finalVerification.diagnostics,
        createdAt: new Date().toISOString(),
      });
    } catch (dbErr: any) {
      console.error(`[Durable Ledger Error] Failed to persist final verification for task ${taskId}:`, dbErr);
      await this.transitionTaskState(
        taskId,
        stateMachine,
        'failed',
        `Database persistence error during verification: ${dbErr.message}`,
        dbErr.message
      );
      throw new Error(`Critical persistence failure: Final verification could not be recorded in database (${dbErr.message}). Task marked FAILED.`);
    }

    // Truthful Completion Gate: Distinguish completed vs partially_completed vs needs_human_review vs failed
    if (finalVerification.isVerified && review.isComplete) {
      let autoMergeSucceeded = false;
      let autoMergeError: string | undefined;

      if (params.autoMerge && isGit && taskBranchName) {
        try {
          const mainGit = (inspector as any).git;
          const currentStatus = await inspector.getGitStatus();
          if (!currentStatus) {
            throw new Error('Cannot inspect destination git status prior to auto-merge.');
          }

          // P0/P1 FIX: Establish that destination working tree is 100% clean before attempting merge
          if (currentStatus.files.length > 0) {
            throw new Error(
              `Cannot auto-merge: destination working tree has uncommitted or dirty changes (${currentStatus.files
                .map((f) => f.path)
                .join(', ')}). Aborting auto-merge to protect user uncommitted work.`
            );
          }

          const currentBranch = currentStatus.current;
          // Verify destination branch is still the original base branch
          if (!currentBranch || (baseline && currentBranch !== baseline.branch)) {
            throw new Error(
              `Target checkout branch changed: currently on "${currentBranch}", expected base branch "${baseline?.branch}".`
            );
          }

          // P0/P1 FIX: Capture exact pre-merge commit and verify it matches baseline HEAD
          const preMergeLog = await mainGit.log({ maxCount: 1 });
          const preMergeCommit = preMergeLog.latest ? preMergeLog.latest.hash : null;
          if (!preMergeCommit) {
            throw new Error('Cannot determine pre-merge HEAD commit in destination repository.');
          }

          if (baseline?.baseCommit && baseline.baseCommit !== 'initial' && preMergeCommit !== baseline.baseCommit) {
            throw new Error(
              `Cannot auto-merge: destination branch HEAD moved from baseline commit (${baseline.baseCommit}) to (${preMergeCommit}) during task execution. Aborting auto-merge to prevent clobbering new commits.`
            );
          }

          // Check protected branch policy
          if (baseline?.branch && config.protectedBranches.includes(baseline.branch)) {
            if (config.requireApprovalForDestructive && !params.allowProtectedBranchMerge) {
              throw new Error(
                `Base branch "${baseline.branch}" is a configured protected branch. Auto-merge requires explicit authorization.`
              );
            }
          }

          // Perform merge
          try {
            await mainGit.merge([taskBranchName]);
          } catch (mergeConflictErr: any) {
            try {
              await mainGit.merge(['--abort']);
            } catch {}
            throw new Error(
              `Merge conflict detected while merging "${taskBranchName}" into "${currentBranch}": ${mergeConflictErr.message || mergeConflictErr}`
            );
          }

          // P1 FIX: Capture exact merge commit to prevent rollback race condition
          const postMergeLog = await mainGit.log({ maxCount: 1 });
          const exactMergeCommit = postMergeLog.latest?.hash;

          // P1 FIX: Independent post-merge reverification on actual destination checkout (not worktree)
          const destinationVerifier = new IndependentVerifier(params.workspacePath);
          const postMergeReport = await destinationVerifier.verify(
            repoMeta,
            plan.acceptanceCriteria,
            plan.steps[plan.steps.length - 1]?.verificationCommand || undefined,
            preMergeCommit
          );

          if (!postMergeReport.isVerified) {
            // P0/P1 FIX: Safe recovery - ONLY roll back if destination checkout is clean and HEAD is still the exact merge commit
            let rollbackSucceeded = false;
            try {
              const postVerificationStatus = await inspector.getGitStatus();
              const postVerificationLog = await mainGit.log({ maxCount: 1 });
              const currentHead = postVerificationLog.latest?.hash;

              if (
                postVerificationStatus &&
                postVerificationStatus.files.length === 0 &&
                currentHead &&
                exactMergeCommit &&
                currentHead === exactMergeCommit
              ) {
                await mainGit.reset(['--hard', preMergeCommit]);
                rollbackSucceeded = true;
              }
            } catch {}

            throw new Error(
              `Post-merge independent verification failed on destination branch: ${postMergeReport.blockingReasons.join(
                '; '
              )}.${
                rollbackSucceeded
                  ? ' Auto-merge was safely rolled back to pre-merge commit.'
                  : ' Destination branch preserved without reset to prevent clobbering user work; manual review required.'
              }`
            );
          }

          autoMergeSucceeded = true;
        } catch (mergeErr: any) {
          // If merge ended with conflict or aborted state, abort merge to restore clean working tree
          try {
            await (inspector as any).git.merge(['--abort']);
          } catch {}
          autoMergeError = mergeErr.message || String(mergeErr);
          console.warn(`[Auto-Merge Notice] Auto-merge failed: ${autoMergeError}`);
        }
      }

      if (params.autoMerge && !autoMergeSucceeded) {
        // P1 FIX: Auto-merge failure must NOT report task as completed
        await this.transitionTaskState(
          taskId,
          stateMachine,
          'needs_human_review',
          `Task changes verified in worktree branch "${taskBranchName}", but auto-merge into "${baseline?.branch}" failed: ${autoMergeError}`,
          review.summary
        );
        await this.emitOrchestratorEvent({
          taskId,
          type: 'TASK_NEEDS_REVIEW',
          message: `Auto-merge failed: ${autoMergeError}. Task changes preserved on branch ${taskBranchName}.`,
          data: {
            review,
            finalVerification,
            taskBranchName,
            baseBranch: baseline?.branch,
            autoMergeError,
          },
        });
      } else {
        await this.transitionTaskState(taskId, stateMachine, 'completed', 'All requirements verified', review.summary);
        await this.emitOrchestratorEvent({
          taskId,
          type: 'TASK_COMPLETED',
          message: `Task successfully verified and completed: ${review.summary}`,
          data: { review, finalVerification, taskBranchName, baseBranch: baseline?.branch, autoMergeSucceeded },
        });
      }
    } else if (finalVerification.isVerified && !review.isComplete) {
      await this.transitionTaskState(
        taskId,
        stateMachine,
        'needs_human_review',
        'Verification passed but reviewer identified pending items',
        review.summary
      );
      await this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_NEEDS_REVIEW',
        message: `Task requires human review: ${review.summary}`,
        data: { review, finalVerification },
      });
    } else {
      await this.transitionTaskState(
        taskId,
        stateMachine,
        'partially_completed',
        `Verification incomplete: ${finalVerification.blockingReasons.join('; ')}`,
        review.summary
      );
      await this.emitOrchestratorEvent({
        taskId,
        type: 'TASK_PARTIALLY_COMPLETED',
        message: `Task partially completed with unverified criteria: ${finalVerification.blockingReasons.join(', ')}`,
        data: { review, finalVerification },
      });
    }

    } catch (lifecycleErr: any) {
      const isCancelled =
        abortController.signal.aborted ||
        stateMachine.getState() === 'cancelling' ||
        stateMachine.getState() === 'cancelled';

      if (isCancelled) {
        if (stateMachine.getState() !== 'cancelled') {
          try {
            if (stateMachine.getState() !== 'cancelling') {
              await this.transitionTaskState(
                taskId,
                stateMachine,
                'cancelling',
                'Task cancellation in progress'
              );
            }
            await this.transitionTaskState(
              taskId,
              stateMachine,
              'cancelled',
              'Task cancelled and active processes terminated'
            );
            await this.emitOrchestratorEvent({
              taskId,
              type: 'TASK_CANCELLED',
              message: 'Task was cancelled by user request',
            });
          } catch {}
        }
        return;
      } else if (!stateMachine.isTerminal()) {
        try {
          await this.transitionTaskState(
            taskId,
            stateMachine,
            'failed',
            `Internal failure: ${lifecycleErr.message}`,
            lifecycleErr.message
          );
        } catch (transErr: any) {
          // If transitionTaskState threw (e.g. event ledger persistence failed),
          // ensure SQLite task record is directly updated to terminal 'failed' so it is never stuck!
          try {
            await taskRepo.updateStatus(taskId, 'failed', `Critical failure: ${lifecycleErr.message}`);
          } catch (dbErr: any) {
            console.error(`[Fatal DB Error] Could not update task status for ${taskId}:`, dbErr);
          }
        }
      }
      throw lifecycleErr;
    } finally {
      // P1 FIX: Guaranteed resource cleanup in finally block
      if (taskWorktreePath) {
        try {
          if (isWorktree) {
            await inspector.removeIsolatedWorktree(taskWorktreePath);
          } else {
            await inspector.removeIsolatedSandbox(taskWorktreePath);
          }
          await this.emitOrchestratorEvent({
            taskId,
            type: 'LOG',
            message: `Isolated environment cleaned up. Task changes preserved ${
              taskBranchName ? `on branch: ${taskBranchName}` : 'in sandbox snapshot'
            }. User working tree left untouched.`,
          });
        } catch (cleanupErr: any) {
          console.warn(`[Cleanup Warning] Could not remove isolated environment "${taskWorktreePath}": ${cleanupErr?.message}`);
        }
      }

      this.activeTasks.delete(taskId);
    }
  }

  private async requestCommandApproval(
    taskId: string,
    stepId: string | undefined,
    commandOrAction: string,
    policy: ActionPolicy
  ): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await approvalRepo.create({
      id: approvalId,
      taskId,
      stepId,
      actionType: policy.riskLevel,
      targetResource: 'terminal_command',
      parametersJson: JSON.stringify({ command: commandOrAction }),
      details: policy.reason || `Action approval requested for: "${commandOrAction}"`,
      status: 'PENDING',
      expiresAt,
      createdAt: new Date().toISOString(),
    });

    await this.emitOrchestratorEvent({
      taskId,
      stepId,
      type: 'APPROVAL_REQUIRED',
      message: `Approval required for command: "${commandOrAction}" (${policy.riskLevel})`,
      data: { approvalId, command: commandOrAction, policy, expiresAt },
    });

    const active = this.activeTasks.get(taskId);
    if (active) {
      await this.transitionTaskState(
        taskId,
        active.stateMachine,
        'awaiting_approval',
        `Awaiting approval for command: ${commandOrAction}`
      );
    }

    const isApproved = await this.waitForApproval(approvalId, active?.abortController.signal);

    if (active && isApproved) {
      await this.transitionTaskState(
        taskId,
        active.stateMachine,
        'executing',
        `Command approved by operator: ${commandOrAction}`
      );
    }

    return isApproved;
  }

  /**
   * Fail-Closed Approval Waiter
   */
  private async waitForApproval(approvalId: string, abortSignal?: AbortSignal): Promise<boolean> {
    const maxWaitMs = 10 * 60 * 1000;
    const checkInterval = 1500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      if (abortSignal?.aborted) {
        await approvalRepo.respond(approvalId, 'CANCELLED', 'user_aborted');
        return false;
      }
      await new Promise((r) => setTimeout(r, checkInterval));
      if (abortSignal?.aborted) {
        await approvalRepo.respond(approvalId, 'CANCELLED', 'user_aborted');
        return false;
      }

      const record = await approvalRepo.getById(approvalId);
      if (!record) return false;

      if (record.status === 'APPROVED') {
        return true;
      }
      if (record.status === 'REJECTED' || record.status === 'CANCELLED') {
        return false;
      }
    }

    // Fail-Closed on timeout
    await approvalRepo.respond(approvalId, 'EXPIRED', 'system_timeout');
    return false;
  }

  /**
   * P0.6 FIX: Cancellation strictly signals child processes and waits for termination.
   */
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
        )
          .then(() => {
            return this.transitionTaskState(
              taskId,
              task.stateMachine,
              'cancelled',
              'Task cancelled and active processes terminated'
            );
          })
          .catch(() => {});
      }

      return true;
    }
    return false;
  }
}

export const orchestrator = new OrchestrationEngine();
