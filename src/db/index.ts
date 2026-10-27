import { createClient, type Client } from '@libsql/client';
import { config } from '../config/index.js';

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  workspacePath: string;
  status: 'PENDING' | 'PLANNING' | 'EXECUTING' | 'VERIFYING' | 'DIAGNOSING' | 'REPAIRING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  retryCount: number;
  maxRetries: number;
  planJson?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StepRecord {
  id: string;
  taskId: string;
  stepIndex: number;
  title: string;
  instruction: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  agent: string;
  toolsUsedJson?: string;
  outputLog?: string;
  diffSummary?: string;
  exitCode?: number;
  createdAt: string;
  completedAt?: string;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  stepId?: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  buildStatus: 'PASSED' | 'FAILED' | 'SKIPPED';
  testStatus: 'PASSED' | 'FAILED' | 'SKIPPED';
  lintStatus: 'PASSED' | 'FAILED' | 'SKIPPED';
  diffInspection: string;
  detailsJson: string;
  diagnostics?: string;
  createdAt: string;
}

export interface CheckpointRecord {
  id: string;
  taskId: string;
  stepId?: string;
  commitHash?: string;
  branchName?: string;
  snapshotDescription: string;
  diffContent?: string;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  stepId?: string;
  actionType: string;
  details: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  respondedAt?: string;
}

let clientInstance: Client | null = null;

export function getDb(): Client {
  if (!clientInstance) {
    clientInstance = createClient({
      url: config.databaseUrl,
    });
  }
  return clientInstance;
}

export async function initDatabase(): Promise<void> {
  const db = getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      status TEXT NOT NULL,
      retryCount INTEGER NOT NULL DEFAULT 0,
      maxRetries INTEGER NOT NULL DEFAULT 3,
      planJson TEXT,
      summary TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      stepIndex INTEGER NOT NULL,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL,
      agent TEXT NOT NULL,
      toolsUsedJson TEXT,
      outputLog TEXT,
      diffSummary TEXT,
      exitCode INTEGER,
      createdAt TEXT NOT NULL,
      completedAt TEXT,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      stepId TEXT,
      status TEXT NOT NULL,
      buildStatus TEXT NOT NULL,
      testStatus TEXT NOT NULL,
      lintStatus TEXT NOT NULL,
      diffInspection TEXT NOT NULL,
      detailsJson TEXT NOT NULL,
      diagnostics TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      stepId TEXT,
      commitHash TEXT,
      branchName TEXT,
      snapshotDescription TEXT NOT NULL,
      diffContent TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      stepId TEXT,
      actionType TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      respondedAt TEXT,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
}

// Database helper operations
export const taskRepo = {
  async create(task: TaskRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO tasks (id, title, prompt, workspacePath, status, retryCount, maxRetries, planJson, summary, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        task.id,
        task.title,
        task.prompt,
        task.workspacePath,
        task.status,
        task.retryCount,
        task.maxRetries,
        task.planJson ?? null,
        task.summary ?? null,
        task.createdAt,
        task.updatedAt,
      ],
    });
  },

  async updateStatus(id: string, status: TaskRecord['status'], summary?: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    const isDone = status === 'COMPLETED' || status === 'FAILED' || status === 'BLOCKED';
    await db.execute({
      sql: `UPDATE tasks SET status = ?, summary = COALESCE(?, summary), updatedAt = ?, completedAt = CASE WHEN ? = 1 THEN ? ELSE completedAt END WHERE id = ?`,
      args: [status, summary ?? null, now, isDone ? 1 : 0, now, id],
    });
  },

  async updatePlan(id: string, planJson: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE tasks SET planJson = ?, updatedAt = ? WHERE id = ?`,
      args: [planJson, now, id],
    });
  },

  async incrementRetry(id: string): Promise<number> {
    const db = getDb();
    const now = new Date().toISOString();
    const res = await db.execute({
      sql: `UPDATE tasks SET retryCount = retryCount + 1, updatedAt = ? WHERE id = ? RETURNING retryCount`,
      args: [now, id],
    });
    return Number(res.rows[0]?.retryCount ?? 0);
  },

  async getById(id: string): Promise<TaskRecord | null> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM tasks WHERE id = ?`,
      args: [id],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      title: String(row.title),
      prompt: String(row.prompt),
      workspacePath: String(row.workspacePath),
      status: row.status as TaskRecord['status'],
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      planJson: row.planJson ? String(row.planJson) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      completedAt: row.completedAt ? String(row.completedAt) : undefined,
    };
  },

  async listAll(limit = 50): Promise<TaskRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?`,
      args: [limit],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      prompt: String(row.prompt),
      workspacePath: String(row.workspacePath),
      status: row.status as TaskRecord['status'],
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      planJson: row.planJson ? String(row.planJson) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      completedAt: row.completedAt ? String(row.completedAt) : undefined,
    }));
  },
};

export const stepRepo = {
  async create(step: StepRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO steps (id, taskId, stepIndex, title, instruction, status, agent, toolsUsedJson, outputLog, diffSummary, exitCode, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        step.id,
        step.taskId,
        step.stepIndex,
        step.title,
        step.instruction,
        step.status,
        step.agent,
        step.toolsUsedJson ?? null,
        step.outputLog ?? null,
        step.diffSummary ?? null,
        step.exitCode ?? null,
        step.createdAt,
      ],
    });
  },

  async update(id: string, updates: Partial<StepRecord>): Promise<void> {
    const db = getDb();
    const sets: string[] = [];
    const args: any[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      args.push(updates.status);
    }
    if (updates.toolsUsedJson !== undefined) {
      sets.push('toolsUsedJson = ?');
      args.push(updates.toolsUsedJson);
    }
    if (updates.outputLog !== undefined) {
      sets.push('outputLog = ?');
      args.push(updates.outputLog);
    }
    if (updates.diffSummary !== undefined) {
      sets.push('diffSummary = ?');
      args.push(updates.diffSummary);
    }
    if (updates.exitCode !== undefined) {
      sets.push('exitCode = ?');
      args.push(updates.exitCode);
    }
    if (updates.completedAt !== undefined) {
      sets.push('completedAt = ?');
      args.push(updates.completedAt);
    }

    if (sets.length === 0) return;

    args.push(id);
    await db.execute({
      sql: `UPDATE steps SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });
  },

  async listForTask(taskId: string): Promise<StepRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM steps WHERE taskId = ? ORDER BY stepIndex ASC`,
      args: [taskId],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      stepIndex: Number(row.stepIndex),
      title: String(row.title),
      instruction: String(row.instruction),
      status: row.status as StepRecord['status'],
      agent: String(row.agent),
      toolsUsedJson: row.toolsUsedJson ? String(row.toolsUsedJson) : undefined,
      outputLog: row.outputLog ? String(row.outputLog) : undefined,
      diffSummary: row.diffSummary ? String(row.diffSummary) : undefined,
      exitCode: row.exitCode !== null ? Number(row.exitCode) : undefined,
      createdAt: String(row.createdAt),
      completedAt: row.completedAt ? String(row.completedAt) : undefined,
    }));
  },
};

export const verificationRepo = {
  async record(v: VerificationRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO verifications (id, taskId, stepId, status, buildStatus, testStatus, lintStatus, diffInspection, detailsJson, diagnostics, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        v.id,
        v.taskId,
        v.stepId ?? null,
        v.status,
        v.buildStatus,
        v.testStatus,
        v.lintStatus,
        v.diffInspection,
        v.detailsJson,
        v.diagnostics ?? null,
        v.createdAt,
      ],
    });
  },

  async listForTask(taskId: string): Promise<VerificationRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM verifications WHERE taskId = ? ORDER BY createdAt DESC`,
      args: [taskId],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      stepId: row.stepId ? String(row.stepId) : undefined,
      status: row.status as VerificationRecord['status'],
      buildStatus: row.buildStatus as VerificationRecord['buildStatus'],
      testStatus: row.testStatus as VerificationRecord['testStatus'],
      lintStatus: row.lintStatus as VerificationRecord['lintStatus'],
      diffInspection: String(row.diffInspection),
      detailsJson: String(row.detailsJson),
      diagnostics: row.diagnostics ? String(row.diagnostics) : undefined,
      createdAt: String(row.createdAt),
    }));
  },
};

export const approvalRepo = {
  async create(a: ApprovalRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO approvals (id, taskId, stepId, actionType, details, status, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [a.id, a.taskId, a.stepId ?? null, a.actionType, a.details, a.status, a.createdAt],
    });
  },

  async respond(id: string, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE approvals SET status = ?, respondedAt = ? WHERE id = ?`,
      args: [status, now, id],
    });
  },

  async getPendingForTask(taskId: string): Promise<ApprovalRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM approvals WHERE taskId = ? AND status = 'PENDING' ORDER BY createdAt ASC`,
      args: [taskId],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      stepId: row.stepId ? String(row.stepId) : undefined,
      actionType: String(row.actionType),
      details: String(row.details),
      status: row.status as ApprovalRecord['status'],
      createdAt: String(row.createdAt),
      respondedAt: row.respondedAt ? String(row.respondedAt) : undefined,
    }));
  },
};
