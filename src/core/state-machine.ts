export type TaskState =
  | 'queued'
  | 'discovering'
  | 'planning'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'verifying'
  | 'diagnosing'
  | 'repairing'
  | 'completed'
  | 'partially_completed'
  | 'blocked'
  | 'needs_human_review'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

export interface StateTransitionEvent {
  from: TaskState;
  to: TaskState;
  reason: string;
  timestamp: string;
}

export class IllegalStateTransitionError extends Error {
  constructor(public from: TaskState, public to: TaskState, reason?: string) {
    super(
      `Illegal task state transition from "${from}" to "${to}"${reason ? ` (${reason})` : ''}`
    );
    this.name = 'IllegalStateTransitionError';
  }
}

export class TaskStateMachine {
  private static readonly VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
    queued: ['discovering', 'cancelling', 'cancelled', 'failed'],
    discovering: ['planning', 'blocked', 'failed', 'cancelling'],
    planning: ['ready', 'awaiting_approval', 'blocked', 'failed', 'cancelling'],
    awaiting_approval: [
      'ready',
      'executing',
      'repairing',
      'verifying',
      'blocked',
      'needs_human_review',
      'cancelling',
      'failed',
    ],
    ready: ['executing', 'awaiting_approval', 'cancelling', 'failed'],
    executing: ['verifying', 'awaiting_approval', 'failed', 'cancelling'],
    verifying: [
      'completed',
      'partially_completed',
      'diagnosing',
      'needs_human_review',
      'blocked',
      'failed',
      'executing',
      'ready',
      'awaiting_approval',
      'cancelling',
    ],
    diagnosing: ['repairing', 'blocked', 'needs_human_review', 'failed', 'cancelling'],
    repairing: ['verifying', 'executing', 'awaiting_approval', 'blocked', 'failed', 'cancelling'],
    cancelling: ['cancelled'],
    // Non-terminal escalation states can transition to resume or cancel
    blocked: ['planning', 'ready', 'cancelling', 'failed'],
    needs_human_review: ['planning', 'ready', 'verifying', 'cancelling', 'failed'],
    // Terminal states have no forward transitions
    completed: [],
    partially_completed: [],
    failed: [],
    cancelled: [],
  };

  private currentState: TaskState;

  constructor(initialState: TaskState = 'queued') {
    this.currentState = initialState;
  }

  getState(): TaskState {
    return this.currentState;
  }

  isTerminal(): boolean {
    return ['completed', 'partially_completed', 'failed', 'cancelled'].includes(this.currentState);
  }

  canTransitionTo(targetState: TaskState): boolean {
    const allowed = TaskStateMachine.VALID_TRANSITIONS[this.currentState] || [];
    return allowed.includes(targetState);
  }

  transition(targetState: TaskState, reason = 'State transition'): StateTransitionEvent {
    if (this.currentState === targetState) {
      return {
        from: this.currentState,
        to: targetState,
        reason: 'No-op transition',
        timestamp: new Date().toISOString(),
      };
    }

    if (!this.canTransitionTo(targetState)) {
      throw new IllegalStateTransitionError(this.currentState, targetState, reason);
    }

    const event: StateTransitionEvent = {
      from: this.currentState,
      to: targetState,
      reason,
      timestamp: new Date().toISOString(),
    };

    this.currentState = targetState;
    return event;
  }
}
