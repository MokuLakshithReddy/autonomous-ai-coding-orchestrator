export interface Task {
  id: string;
  title: string;
  prompt: string;
  workspacePath: string;
  status:
    | 'discovering'
    | 'planning'
    | 'ready'
    | 'executing'
    | 'verifying'
    | 'diagnosing'
    | 'repairing'
    | 'awaiting_approval'
    | 'needs_human_review'
    | 'completed'
    | 'partially_completed'
    | 'failed'
    | 'blocked'
    | 'cancelling'
    | 'cancelled'
    | string;
  retryCount: number;
  maxRetries: number;
  planJson?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: string;
  taskId: string;
  stepIndex: number;
  title: string;
  instruction: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | string;
  agent: string;
  toolsUsedJson?: string;
  outputLog?: string;
  diffSummary?: string;
  exitCode?: number;
}

export interface Verification {
  id: string;
  taskId: string;
  status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | string;
  buildStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | string;
  testStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | string;
  lintStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | string;
  diffInspection: string;
  diagnostics?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  stepIndex?: number;
  command?: string;
  actionType?: string;
  details: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  respondedAt?: string;
}

export interface TaskDetailsData {
  task: Task;
  steps: Step[];
  verifications: Verification[];
  pendingApprovals: Approval[];
}

export interface WsEvent {
  id: string;
  taskId?: string;
  type: string;
  message: string;
  data?: any;
  timestamp: string;
}

export interface SystemStatus {
  status: string;
  geminiConfigured: boolean;
  geminiModel: string;
  maxRetryBudget: number;
  stepTimeoutSeconds: number;
  autoRepairEnabled: boolean;
  containerSandboxEnabled: boolean;
  workspacePolicy: 'restricted' | 'unrestricted';
  version: string;
  defaultWorkspace?: string;
}

export interface RepoMeta {
  branch?: string;
  commitHash?: string;
  isClean?: boolean;
  ecosystems?: string[];
  packageManagers?: string[];
  testRunners?: string[];
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  uncommittedFiles?: string[];
  untrackedFiles?: string[];
}

export interface PlanStep {
  index: number;
  title: string;
  instruction: string;
  targetFiles?: string[];
  dependencies?: number[];
  estimatedComplexity?: 'low' | 'medium' | 'high';
}

export interface ExecutionPlan {
  summary: string;
  analysis?: string;
  steps: PlanStep[];
  acceptanceCriteria: string[];
  riskAssessment?: string;
  recommendedAgent?: string;
}

