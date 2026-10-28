import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  port: z.coerce.number().default(4000),
  host: z.string().default('127.0.0.1'),
  databaseUrl: z.string().default('file:orchestrator.db'),
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().default('gemini-2.5-flash'),
  maxRetryBudget: z.coerce.number().default(3),
  stepTimeoutSeconds: z.coerce.number().default(300),
  autoRepairEnabled: z.boolean().default(true),
  requireApprovalForDestructive: z.boolean().default(true),
  protectedBranches: z.array(z.string()).default(['main', 'master', 'production']),
  allowedWorkspaces: z.array(z.string()).default([]),
  allowUnrestrictedWorkspaces: z.boolean().default(false),
  apiToken: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const protectedBranchesRaw = process.env.PROTECTED_BRANCHES || 'main,master,production';
  const allowedWorkspacesRaw = process.env.ALLOWED_DIRECTORIES || '';

  const parsed = ConfigSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    databaseUrl: process.env.DATABASE_URL,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    maxRetryBudget: process.env.MAX_RETRY_BUDGET,
    stepTimeoutSeconds: process.env.STEP_TIMEOUT_SECONDS,
    autoRepairEnabled: process.env.AUTO_REPAIR_ENABLED !== 'false',
    requireApprovalForDestructive: process.env.REQUIRE_APPROVAL_FOR_DESTRUCTIVE !== 'false',
    protectedBranches: protectedBranchesRaw.split(',').map((s) => s.trim()).filter(Boolean),
    allowedWorkspaces: allowedWorkspacesRaw.split(';').map((s) => path.resolve(s.trim())).filter(Boolean),
    allowUnrestrictedWorkspaces: process.env.ALLOW_UNRESTRICTED_WORKSPACES === 'true',
    apiToken: process.env.ORCHESTRATOR_API_TOKEN || process.env.API_TOKEN,
  });

  return parsed;
}

export const config = loadConfig();
