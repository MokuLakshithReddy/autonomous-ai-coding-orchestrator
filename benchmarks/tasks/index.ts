import path from 'node:path';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { BenchmarkTaskDefinition } from './types.js';
import { tsBenchmarkTasks } from './ts-tasks.js';
import { pyBenchmarkTasks } from './py-tasks.js';
import { secBenchmarkTasks } from './sec-tasks.js';

export * from './types.js';

export const allBenchmarkTasks: BenchmarkTaskDefinition[] = [
  ...tsBenchmarkTasks,
  ...pyBenchmarkTasks,
  ...secBenchmarkTasks,
];

export async function setupTaskWorkspace(
  task: BenchmarkTaskDefinition,
  baseDir: string
): Promise<{ repoDir: string; initialCommit: string }> {
  const repoDir = path.join(baseDir, task.id);
  await fs.mkdir(repoDir, { recursive: true });

  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.name', 'BenchmarkRunner');
  await git.addConfig('user.email', 'benchmark@orchestrator.local');

  for (const file of task.files) {
    const fullPath = path.join(repoDir, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf8');
  }

  await git.add('.');
  await git.commit(`Initial commit for benchmark task: ${task.id}`);
  const log = await git.log({ maxCount: 1 });
  const initialCommit = log.latest ? log.latest.hash : 'initial';

  return { repoDir, initialCommit };
}

