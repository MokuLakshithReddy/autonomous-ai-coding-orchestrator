import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config/index.js';
import {
  initDatabase,
  taskRepo,
  stepRepo,
  verificationRepo,
  approvalRepo,
  eventRepo,
} from '../db/index.js';
import { z } from 'zod';
import { RepoInspector } from '../repo/inspector.js';
import { orchestrator, type OrchestratorEvent } from '../orchestrator/engine.js';
import { LLMBrain } from '../llm/index.js';
import { SecurityPolicyEngine } from '../security/policy.js';

import crypto from 'node:crypto';

export const serverApiToken: string = config.apiToken || crypto.randomBytes(24).toString('hex');

interface WsTicket {
  ticket: string;
  expiresAt: number;
}
export const wsTickets = new Map<string, WsTicket>();
export const MAX_WS_TICKETS = 1000;

export function cleanupExpiredWsTickets(now = Date.now()): number {
  let cleaned = 0;
  for (const [ticket, item] of wsTickets.entries()) {
    if (now > item.expiresAt) {
      wsTickets.delete(ticket);
      cleaned++;
    }
  }
  return cleaned;
}

export function issueWsTicket(ttlMs = 60_000): string {
  cleanupExpiredWsTickets();
  if (wsTickets.size >= MAX_WS_TICKETS) {
    throw new Error('WebSocket ticket store capacity exhausted; cannot issue new ticket');
  }
  const ticket = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  wsTickets.set(ticket, { ticket, expiresAt });
  return ticket;
}

export function consumeWsTicket(ticket: string, now = Date.now()): boolean {
  cleanupExpiredWsTickets(now);
  const item = wsTickets.get(ticket);
  if (!item) return false;
  wsTickets.delete(ticket);
  return now <= item.expiresAt;
}

export function validateWorkspacePath(
  requestedPath?: string,
  allowedRoots: string[] = config.allowedWorkspaces.length > 0 ? config.allowedWorkspaces : [process.cwd()],
  options?: { allowUnrestricted?: boolean; forceCaseSensitive?: boolean }
): string {
  const targetRaw = requestedPath || process.cwd();
  const allowUnrestricted = options?.allowUnrestricted ?? config.allowUnrestrictedWorkspaces;

  try {
    const authorized = SecurityPolicyEngine.validateWorkspaceAuthorization(
      targetRaw,
      allowedRoots,
      { allowUnrestricted, forceCaseSensitive: options?.forceCaseSensitive }
    );
    return SecurityPolicyEngine.assertPathContainment(authorized, authorized);
  } catch (err: any) {
    throw new Error(`Forbidden: ${err.message}`);
  }
}

export async function createServer() {
  await initDatabase();
  await orchestrator.recoverIncompleteTasks();

  const fastify = Fastify({
    logger: false,
  });

  // P0.4 FIX: Replace wildcard CORS with strict origin validation
  const allowedOrigins = [
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server) or from allowed local origins
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS blocked: Origin "${origin}" not authorized.`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // P0 & P1 FIX: Token-based authentication middleware on sensitive and mutating endpoints
  // Strictly requires Authorization: Bearer <token> or x-api-token header (rejects query-string tokens on HTTP)
  fastify.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url || '';
    // Public paths: health check, root, static assets, and WebSocket upgrade route
    // (WebSocket route enforces its own authentication via single-use ticket or handshake)
    if (
      url === '/api/system/status' ||
      url === '/' ||
      url.startsWith('/index.html') ||
      url.startsWith('/ws') ||
      !url.startsWith('/api')
    ) {
      return;
    }

    const authHeader = req.headers['authorization'];
    const tokenHeader = req.headers['x-api-token'];

    let providedToken: string | undefined;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (typeof tokenHeader === 'string') {
      providedToken = tokenHeader.trim();
    }

    if (!providedToken || providedToken !== serverApiToken) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message:
          'A valid API token is required via Authorization: Bearer <token> or x-api-token header.',
      });
    }
  });

  await fastify.register(websocket);

  // Serve static web frontend bundle if available
  const webDistPath = path.join(process.cwd(), 'web/dist');
  if (fs.existsSync(webDistPath)) {
    await fastify.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
    });
    fastify.setNotFoundHandler(async (request, reply) => {
      if (!request.raw.url?.startsWith('/api') && !request.raw.url?.startsWith('/ws')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Endpoint not found' });
    });
  }

  // WebSocket connection pool for real-time live events
  const wsClients = new Set<WebSocket>();

  orchestrator.on('event', (event: OrchestratorEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  });

  // Issue short-lived, single-use ticket for WebSocket authentication
  fastify.post('/api/auth/ws-ticket', async (req, reply) => {
    const authHeader = req.headers['authorization'];
    const token =
      req.headers['x-api-token'] ||
      (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : undefined);
    if (token !== serverApiToken) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid API token' });
    }
    try {
      const ticket = issueWsTicket();
      return { ticket, expiresInSeconds: 60 };
    } catch (err: any) {
      if (err.message?.includes('capacity exhausted')) {
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: 'WebSocket ticket store capacity exhausted. Please try again later.',
        });
      }
      throw err;
    }
  });

  fastify.register(async function (fastifyInstance) {
    fastifyInstance.get('/ws', { websocket: true }, (socket, req) => {
      // Validate origin if present
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        socket.close(1008, 'Origin not authorized');
        return;
      }

      // Security Fix: Explicitly reject long-lived API tokens in query strings to prevent URL credential exposure
      const queryToken = (req.query as any)?.token;
      if (queryToken) {
        socket.close(1008, 'Unauthorized: Long-lived token in URL query is forbidden');
        return;
      }

      const queryTicket = (req.query as any)?.ticket;
      const headerToken = req.headers['x-api-token'];
      const authHeader = req.headers['authorization'];
      const token =
        headerToken ||
        (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : undefined);

      let isAuthenticated = false;

      // Method 1: Single-use connection ticket in query string
      if (queryTicket && consumeWsTicket(queryTicket)) {
        isAuthenticated = true;
      }

      // Method 2: HTTP upgrade headers
      if (!isAuthenticated && token && token === serverApiToken) {
        isAuthenticated = true;
      }

      const activateConnection = () => {
        wsClients.add(socket);
        socket.send(
          JSON.stringify({
            type: 'CONNECTED',
            message: 'Connected to Orchestrator Realtime Stream',
            timestamp: new Date().toISOString(),
          })
        );

        socket.on('close', () => {
          wsClients.delete(socket);
        });
      };

      if (isAuthenticated) {
        activateConnection();
      } else {
        // Method 3: Authenticated initial handshake message within 5 seconds
        let authTimer: NodeJS.Timeout | null = setTimeout(() => {
          if (!isAuthenticated) {
            socket.close(1008, 'Unauthorized: Handshake authentication timed out');
          }
        }, 5000);

        socket.on('message', (data: any) => {
          if (isAuthenticated) return;
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'AUTH') {
              if (msg.ticket && consumeWsTicket(msg.ticket)) {
                isAuthenticated = true;
              } else if (msg.token && msg.token === serverApiToken) {
                isAuthenticated = true;
              }
            }
          } catch {}

          if (isAuthenticated) {
            if (authTimer) {
              clearTimeout(authTimer);
              authTimer = null;
            }
            activateConnection();
          } else {
            socket.close(1008, 'Unauthorized: Invalid handshake credentials');
          }
        });
      }
    });
  });

  // System & Health Endpoints
  // P1 FIX: Return only non-sensitive status information from unauthenticated public endpoint.
  // Absolute host paths (defaultWorkspace, allowedWorkspaces) are excluded to prevent host filesystem information disclosure.
  fastify.get('/api/system/status', async () => {
    const brain = new LLMBrain();
    return {
      status: 'online',
      geminiConfigured: brain.isConfigured(),
      geminiModel: config.geminiModel,
      maxRetryBudget: config.maxRetryBudget,
      stepTimeoutSeconds: config.stepTimeoutSeconds,
      autoRepairEnabled: config.autoRepairEnabled,
      containerSandboxEnabled: config.useContainerSandbox,
      workspacePolicy: config.allowUnrestrictedWorkspaces ? 'unrestricted' : 'restricted',
      version: '1.0.0',
    };
  });

  const GeminiConfigSchema = z.object({
    apiKey: z.string().min(1).max(500),
    model: z.string().max(100).optional(),
  });

  fastify.post('/api/config/gemini', async (req, reply) => {
    const parseRes = GeminiConfigSchema.safeParse(req.body);
    if (!parseRes.success) {
      return reply.status(400).send({ error: parseRes.error.issues[0]?.message || 'Invalid Gemini configuration' });
    }
    const { apiKey, model } = parseRes.data;
    config.geminiApiKey = apiKey;
    if (model) config.geminiModel = model;
    return { success: true, message: 'Gemini configuration updated.' };
  });

  // Repository Inspection Endpoint
  fastify.post<{ Body: { workspacePath?: string } }>('/api/repo/inspect', async (req, reply) => {
    try {
      // P0 FIX: Validate against authorized workspace roots
      const safeWorkspace = validateWorkspacePath(req.body?.workspacePath);
      const inspector = new RepoInspector(safeWorkspace);
      const isGit = await inspector.isGitRepository();
      if (!isGit) {
        return reply.status(400).send({
          error: `Workspace "${safeWorkspace}" is not a Git repository. Autonomous coding requires a Git repository.`,
          message: `Workspace "${safeWorkspace}" is not a Git repository. Autonomous coding requires a Git repository.`,
        });
      }
      const meta = await inspector.inspect();
      return { workspacePath: safeWorkspace, meta };
    } catch (err: any) {
      return reply.status(403).send({ error: err.message, message: err.message });
    }
  });

  // Tasks Endpoints
  fastify.get('/api/tasks', async () => {
    const tasks = await taskRepo.listAll(100);
    return { tasks };
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = await taskRepo.getById(req.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }
    const steps = await stepRepo.listForTask(task.id);
    const verifications = await verificationRepo.listForTask(task.id);
    const pendingApprovals = await approvalRepo.getPendingForTask(task.id);

    return {
      task,
      steps,
      verifications,
      pendingApprovals,
    };
  });

  // P1 FIX: Expose persisted execution event stream for reloads and auditability
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/tasks/:id/events',
    async (req, reply) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
      const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
      const events = await eventRepo.listForTask(req.params.id, limit, offset);
      return { events, limit, offset };
    }
  );

  const CreateTaskSchema = z.object({
    prompt: z.string().min(1, 'Prompt is required').max(10000, 'Prompt exceeds maximum length of 10000 characters'),
    workspacePath: z.string().max(1000).optional(),
    title: z.string().max(200).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    agent: z.enum(['builtin', 'aider', 'claude']).optional(),
    autoMerge: z.boolean().optional(),
  });

  fastify.post('/api/tasks', async (req, reply) => {
    const parseRes = CreateTaskSchema.safeParse(req.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: parseRes.error.issues[0]?.message || 'Invalid task payload',
        message: parseRes.error.issues[0]?.message || 'Invalid task payload',
      });
    }
    const { prompt, workspacePath, title, maxRetries, agent, autoMerge } = parseRes.data;

    // P0 FIX: Verify workspace is within authorized boundaries
    let resolvedWorkspace: string;
    try {
      resolvedWorkspace = validateWorkspacePath(workspacePath);
    } catch (err: any) {
      return reply.status(403).send({ error: err.message, message: err.message });
    }

    // P1 FIX: Explicitly require Git workspace upfront
    const inspector = new RepoInspector(resolvedWorkspace);
    const isGit = await inspector.isGitRepository();
    if (!isGit) {
      return reply.status(400).send({
        error: `Workspace "${resolvedWorkspace}" is not a Git repository. Autonomous coding requires a Git repository for isolated branch checkpoints, worktrees, and safe rollbacks. Please run "git init" in that directory or select an existing Git repository.`,
        message: `Workspace "${resolvedWorkspace}" is not a Git repository. Autonomous coding requires a Git repository for isolated branch checkpoints, worktrees, and safe rollbacks. Please run "git init" in that directory or select an existing Git repository.`,
      });
    }

    const task = await orchestrator.runTask({
      prompt,
      workspacePath: resolvedWorkspace,
      title,
      maxRetries,
      agentType: agent,
      autoMerge,
    });

    return reply.status(201).send({ task });
  });

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => {
    const cancelled = orchestrator.cancelTask(req.params.id);
    return { cancelled };
  });

  // P1 FIX: Durable task resumption API endpoint
  fastify.post<{ Params: { id: string }; Body?: { autoMerge?: boolean; agent?: 'builtin' | 'aider' | 'claude' } }>(
    '/api/tasks/:id/resume',
    async (req, reply) => {
      try {
        const task = await orchestrator.resumeTask(req.params.id, {
          autoMerge: req.body?.autoMerge,
          agentType: req.body?.agent,
        });
        return reply.status(200).send({ success: true, task });
      } catch (err: any) {
        return reply.status(400).send({ error: err.message, message: err.message });
      }
    }
  );

  const ApprovalRespondSchema = z.object({
    status: z.enum(['APPROVED', 'REJECTED']),
  });

  fastify.post<{ Params: { id: string } }>(
    '/api/approvals/:id/respond',
    async (req, reply) => {
      const parseRes = ApprovalRespondSchema.safeParse(req.body);
      if (!parseRes.success) {
        return reply.status(400).send({ error: 'Status must be APPROVED or REJECTED' });
      }
      const resolved = await approvalRepo.respond(req.params.id, parseRes.data.status);
      if (!resolved) {
        return reply.status(409).send({ error: 'Approval was already resolved or has expired' });
      }
      return { success: true };
    }
  );

  return fastify;
}
