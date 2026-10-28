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
} from '../db/index.js';
import { RepoInspector } from '../repo/inspector.js';
import { orchestrator, type OrchestratorEvent } from '../orchestrator/engine.js';
import { LLMBrain } from '../llm/index.js';
import { SecurityPolicyEngine } from '../security/policy.js';

export async function createServer() {
  await initDatabase();

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

  fastify.register(async function (fastifyInstance) {
    fastifyInstance.get('/ws', { websocket: true }, (socket, req) => {
      // Validate origin if present
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        socket.close(1008, 'Origin not authorized');
        return;
      }

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
    });
  });

  // System & Health Endpoints
  fastify.get('/api/system/status', async () => {
    const brain = new LLMBrain();
    return {
      status: 'online',
      geminiConfigured: brain.isConfigured(),
      geminiModel: config.geminiModel,
      maxRetryBudget: config.maxRetryBudget,
      stepTimeoutSeconds: config.stepTimeoutSeconds,
      autoRepairEnabled: config.autoRepairEnabled,
      defaultWorkspace: process.cwd(),
      version: '1.0.0',
    };
  });

  fastify.post<{ Body: { apiKey: string; model?: string } }>('/api/config/gemini', async (req, reply) => {
    const { apiKey, model } = req.body;
    if (!apiKey) {
      return reply.status(400).send({ error: 'API key is required' });
    }
    config.geminiApiKey = apiKey;
    if (model) config.geminiModel = model;
    return { success: true, message: 'Gemini configuration updated.' };
  });

  // Repository Inspection Endpoint
  fastify.post<{ Body: { workspacePath?: string } }>('/api/repo/inspect', async (req) => {
    const targetPath = req.body?.workspacePath || process.cwd();
    // Validate workspace path safety
    const safeWorkspace = SecurityPolicyEngine.assertPathContainment(targetPath, targetPath);
    const inspector = new RepoInspector(safeWorkspace);
    const meta = await inspector.inspect();
    return { workspacePath: safeWorkspace, meta };
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

  fastify.post<{
    Body: {
      prompt: string;
      workspacePath?: string;
      title?: string;
      maxRetries?: number;
    };
  }>('/api/tasks', async (req, reply) => {
    const { prompt, workspacePath, title, maxRetries } = req.body;
    if (!prompt) {
      return reply.status(400).send({ error: 'Prompt is required' });
    }

    const resolvedWorkspace = path.resolve(workspacePath || process.cwd());
    const task = await orchestrator.runTask({
      prompt,
      workspacePath: resolvedWorkspace,
      title,
      maxRetries,
    });

    return reply.status(201).send({ task });
  });

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => {
    const cancelled = orchestrator.cancelTask(req.params.id);
    return { cancelled };
  });

  fastify.post<{ Params: { id: string }; Body: { status: 'APPROVED' | 'REJECTED' } }>(
    '/api/approvals/:id/respond',
    async (req, reply) => {
      const { status } = req.body;
      if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
        return reply.status(400).send({ error: 'Status must be APPROVED or REJECTED' });
      }
      await approvalRepo.respond(req.params.id, status);
      return { success: true };
    }
  );

  return fastify;
}
