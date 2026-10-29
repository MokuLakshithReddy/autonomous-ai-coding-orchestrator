export interface TaskSeedFile {
  path: string;
  content: string;
}

export interface BenchmarkTaskDefinition {
  id: string;
  title: string;
  description: string;
  language: 'typescript' | 'javascript' | 'python';
  category:
    | 'syntax'
    | 'logic'
    | 'regression'
    | 'multi-file'
    | 'dependency'
    | 'multi-step'
    | 'security-rejection';
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: string;
  isUnsafe: boolean;
  expectedOutcome: 'completed' | 'blocked' | 'failed';
  files: TaskSeedFile[];
  testCommand: string;
  acceptanceCriteria: string[];
  deterministicFix?: (
    targetDir: string,
    attempt: number
  ) => Promise<{ filesWritten: string[]; log: string }>;
  adversarialAction?: (
    targetDir: string
  ) => Promise<{ filesWritten: string[]; log: string }>;
}

