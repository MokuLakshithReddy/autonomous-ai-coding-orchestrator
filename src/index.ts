import fs from 'node:fs';
import { createServer, serverApiToken } from './server/index.js';
import { config } from './config/index.js';

export * from './config/index.js';
export * from './db/index.js';
export * from './repo/inspector.js';
export * from './llm/index.js';
export * from './agent/index.js';
export * from './agent/tools.js';
export * from './verifier/index.js';
export * from './orchestrator/engine.js';
export * from './server/index.js';

async function bootstrap() {
  const server = await createServer();
  const address = await server.listen({
    port: config.port,
    host: config.host,
  });

  // P1 FIX: Store token in secure local file rather than printing plaintext secret to stdout
  try {
    fs.writeFileSync('.orchestrator-token', serverApiToken, { mode: 0o600 });
  } catch {}

  console.log(`\n======================================================`);
  console.log(`   AUTONOMOUS AI CODING ORCHESTRATOR IS ACTIVE       `);
  console.log(`======================================================`);
  console.log(`Server URL:        ${address}`);
  console.log(`Web Dashboard:     ${address}`);
  console.log(`Realtime Stream:   ws://${config.host}:${config.port}/ws`);
  console.log(`API Auth Token:    [CONFIGURED] (Hidden for security; saved to .orchestrator-token)`);
  console.log(`SQLite Database:   ${config.databaseUrl}`);
  console.log(`Brain Model:       ${config.geminiModel}`);
  console.log(`Auto Repair:       ${config.autoRepairEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`Max Retry Budget:  ${config.maxRetryBudget}`);
  console.log(`======================================================\n`);
}

// Start if executed directly
if (process.argv[1] && process.argv[1].endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  bootstrap().catch((err) => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}
