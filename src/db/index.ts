import { createClient, type Client } from '@libsql/client';
import { config } from '../config/index.js';
import type { TaskState } from '../core/state-machine.js';

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  workspacePath: string;
  status: TaskState;
  retryCount: number;
  maxRetries: number;
  attemptId: string;
  planJson?: string;
  summary?: string;
  budgetsJson?: string;
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
  durationMs?: number;
  createdAt: string;
  completedAt?: string;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  stepId?: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'INCONCLUSIVE';
  buildStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED';
  testStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED' | 'NOT_RUN';
  lintStatus: 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED';
  diffInspection: string;
  detailsJson: string;
  diagnostics?: string;
  createdAt: string;
}

export interface CheckpointRecord {
  id: string;
  taskId: string;
  attemptId?: string;
  stepId?: string;
  baseCommit?: string;
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
  targetResource?: string;
  parametersJson?: string;
  details: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  requestedBy?: string;
  approvedBy?: string;
  expiresAt?: string;
  createdAt: string;
  respondedAt?: string;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  fromState?: TaskState;
  toState?: TaskState;
  message: string;
  dataJson?: string;
  timestamp: string;
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

  try {
    await db.execute('PRAGMA journal_mode = WAL;');
    await db.execute('PRAGMA busy_timeout = 5000;');
  } catch {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      status TEXT NOT NULL,
      retryCount INTEGER NOT NULL DEFAULT 0,
      maxRetries INTEGER NOT NULL DEFAULT 3,
      attemptId TEXT NOT NULL DEFAULT 'initial',
      planJson TEXT,
      summary TEXT,
      budgetsJson TEXT,
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
      durationMs INTEGER,
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
      attemptId TEXT,
      stepId TEXT,
      baseCommit TEXT,
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
      targetResource TEXT,
      parametersJson TEXT,
      details TEXT NOT NULL,
      status TEXT NOT NULL,
      requestedBy TEXT,
      approvedBy TEXT,
      expiresAt TEXT,
      createdAt TEXT NOT NULL,
      respondedAt TEXT,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      fromState TEXT,
      toState TEXT,
      message TEXT NOT NULL,
      dataJson TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  // Safe schema migrations for existing databases
  const migrations = [
    { table: 'tasks', col: 'attemptId TEXT DEFAULT "initial"' },
    { table: 'tasks', col: 'budgetsJson TEXT' },
    { table: 'tasks', col: 'summary TEXT' },
    { table: 'tasks', col: 'planJson TEXT' },
    { table: 'tasks', col: 'completedAt TEXT' },
    { table: 'checkpoints', col: 'attemptId TEXT' },
    { table: 'checkpoints', col: 'stepId TEXT' },
    { table: 'checkpoints', col: 'baseCommit TEXT' },
    { table: 'checkpoints', col: 'commitHash TEXT' },
    { table: 'checkpoints', col: 'branchName TEXT' },
    { table: 'checkpoints', col: 'diffContent TEXT' },
    { table: 'steps', col: 'durationMs INTEGER' },
    { table: 'steps', col: 'exitCode INTEGER' },
    { table: 'steps', col: 'diffSummary TEXT' },
    { table: 'steps', col: 'toolsUsedJson TEXT' },
    { table: 'steps', col: 'outputLog TEXT' },
    { table: 'approvals', col: 'targetResource TEXT' },
    { table: 'approvals', col: 'stepId TEXT' },
    { table: 'approvals', col: 'parametersJson TEXT' },
    { table: 'approvals', col: 'requestedBy TEXT' },
    { table: 'approvals', col: 'approvedBy TEXT' },
    { table: 'approvals', col: 'expiresAt TEXT' },
    { table: 'approvals', col: 'respondedAt TEXT' },
  ];
  // P1 FIX: Inspect existing database schema and execute safe versioned column migrations
  const tableColumnsCache = new Map<string, Set<string>>();

  for (const m of migrations) {
    let existingCols = tableColumnsCache.get(m.table);
    if (!existingCols) {
      const tableInfo = await db.execute(`PRAGMA table_info(${m.table})`);
      existingCols = new Set(tableInfo.rows.map((r) => String(r.name).toLowerCase()));
      tableColumnsCache.set(m.table, existingCols);
    }

    const colName = m.col.split(/\s+/)[0].toLowerCase();
    if (existingCols.has(colName)) {
      // Column already exists cleanly
      continue;
    }

    try {
      await db.execute(`ALTER TABLE ${m.table} ADD COLUMN ${m.col}`);
      existingCols.add(colName);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (/duplicate column name/i.test(errMsg)) {
        // Explicitly recognized safe duplicate column case
        existingCols.add(colName);
        continue;
      }
      console.error(`[Database Migration Error] Failed to alter table "${m.table}" adding "${m.col}":`, err);
      throw new Error(`Database Migration Failure on table "${m.table}" adding "${m.col}": ${errMsg}`);
    }
  }

  // Indexes for performance
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(taskId)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(taskId)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(taskId, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(taskId)`);
}

export const taskRepo = {
  async create(task: TaskRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO tasks (id, title, prompt, workspacePath, status, retryCount, maxRetries, attemptId, planJson, summary, budgetsJson, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        task.id,
        task.title,
        task.prompt,
        task.workspacePath,
        task.status,
        task.retryCount,
        task.maxRetries,
        task.attemptId,
        task.planJson ?? null,
        task.summary ?? null,
        task.budgetsJson ?? null,
        task.createdAt,
        task.updatedAt,
      ],
    });
  },

  async updateStatus(id: string, status: TaskState, summary?: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    const isDone = ['completed', 'partially_completed', 'failed', 'cancelled'].includes(status);
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
      status: row.status as TaskState,
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      attemptId: String(row.attemptId || 'initial'),
      planJson: row.planJson ? String(row.planJson) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      budgetsJson: row.budgetsJson ? String(row.budgetsJson) : undefined,
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
      status: row.status as TaskState,
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      attemptId: String(row.attemptId || 'initial'),
      planJson: row.planJson ? String(row.planJson) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      budgetsJson: row.budgetsJson ? String(row.budgetsJson) : undefined,
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
      sql: `INSERT INTO steps (id, taskId, stepIndex, title, instruction, status, agent, toolsUsedJson, outputLog, diffSummary, exitCode, durationMs, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        step.durationMs ?? null,
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
    if (updates.durationMs !== undefined) {
      sets.push('durationMs = ?');
      args.push(updates.durationMs);
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
      durationMs: row.durationMs !== null ? Number(row.durationMs) : undefined,
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
      sql: `INSERT INTO approvals (id, taskId, stepId, actionType, targetResource, parametersJson, details, status, requestedBy, expiresAt, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        a.id,
        a.taskId,
        a.stepId ?? null,
        a.actionType,
        a.targetResource ?? null,
        a.parametersJson ?? null,
        a.details,
        a.status,
        a.requestedBy ?? null,
        a.expiresAt ?? null,
        a.createdAt,
      ],
    });
  },

  async getById(id: string): Promise<ApprovalRecord | null> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM approvals WHERE id = ?`,
      args: [id],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      taskId: String(row.taskId),
      stepId: row.stepId ? String(row.stepId) : undefined,
      actionType: String(row.actionType),
      targetResource: row.targetResource ? String(row.targetResource) : undefined,
      parametersJson: row.parametersJson ? String(row.parametersJson) : undefined,
      details: String(row.details),
      status: row.status as ApprovalRecord['status'],
      requestedBy: row.requestedBy ? String(row.requestedBy) : undefined,
      approvedBy: row.approvedBy ? String(row.approvedBy) : undefined,
      expiresAt: row.expiresAt ? String(row.expiresAt) : undefined,
      createdAt: String(row.createdAt),
      respondedAt: row.respondedAt ? String(row.respondedAt) : undefined,
    };
  },

  async respond(id: string, status: 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED', approver = 'operator'): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE approvals SET status = ?, approvedBy = ?, respondedAt = ? WHERE id = ?`,
      args: [status, approver, now, id],
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
      targetResource: row.targetResource ? String(row.targetResource) : undefined,
      parametersJson: row.parametersJson ? String(row.parametersJson) : undefined,
      details: String(row.details),
      status: row.status as ApprovalRecord['status'],
      requestedBy: row.requestedBy ? String(row.requestedBy) : undefined,
      approvedBy: row.approvedBy ? String(row.approvedBy) : undefined,
      expiresAt: row.expiresAt ? String(row.expiresAt) : undefined,
      createdAt: String(row.createdAt),
      respondedAt: row.respondedAt ? String(row.respondedAt) : undefined,
    }));
  },
};

export const eventRepo = {
  async append(event: TaskEventRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO task_events (id, taskId, eventType, fromState, toState, message, dataJson, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        event.id,
        event.taskId,
        event.eventType,
        event.fromState ?? null,
        event.toState ?? null,
        event.message,
        event.dataJson ?? null,
        event.timestamp,
      ],
    });
  },

  async listForTask(taskId: string): Promise<TaskEventRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM task_events WHERE taskId = ? ORDER BY timestamp ASC`,
      args: [taskId],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      eventType: String(row.eventType),
      fromState: row.fromState ? (row.fromState as TaskState) : undefined,
      toState: row.toState ? (row.toState as TaskState) : undefined,
      message: String(row.message),
      dataJson: row.dataJson ? String(row.dataJson) : undefined,
      timestamp: String(row.timestamp),
    }));
  },
};

export const checkpointRepo = {
  async record(c: CheckpointRecord): Promise<void> {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO checkpoints (id, taskId, attemptId, stepId, baseCommit, commitHash, branchName, snapshotDescription, diffContent, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        c.id,
        c.taskId,
        c.attemptId ?? null,
        c.stepId ?? null,
        c.baseCommit ?? null,
        c.commitHash ?? null,
        c.branchName ?? null,
        c.snapshotDescription,
        c.diffContent ?? null,
        c.createdAt,
      ],
    });
  },

  async listForTask(taskId: string): Promise<CheckpointRecord[]> {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT * FROM checkpoints WHERE taskId = ? ORDER BY createdAt DESC`,
      args: [taskId],
    });
    return res.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      attemptId: row.attemptId ? String(row.attemptId) : undefined,
      stepId: row.stepId ? String(row.stepId) : undefined,
      baseCommit: row.baseCommit ? String(row.baseCommit) : undefined,
      commitHash: row.commitHash ? String(row.commitHash) : undefined,
      branchName: row.branchName ? String(row.branchName) : undefined,
      snapshotDescription: String(row.snapshotDescription),
      diffContent: row.diffContent ? String(row.diffContent) : undefined,
      createdAt: String(row.createdAt),
    }));
  },
};
