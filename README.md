# Autonomous AI Coding Orchestrator

An enterprise-grade, local-first closed-loop engineering system connecting a Large Language Model (**The Brain**) with an autonomous coding agent (**The Engineer**) and an independent verification engine (**The Verifier**).

---

## 🏛 Architecture Overview

```
                      +-----------------------------+
                      |      User Task / Mission    |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |     Orchestration Engine    |
                      |   (State Machine & Ledger)  |
                      +--------------+--------------+
                                     |
              +----------------------+----------------------+
              |                                             |
              v                                             v
+---------------------------+                 +---------------------------+
|    The Brain (LLM)        |                 |   The Engineer (Agent)    |
| - Requirement Analysis    |                 | - Built-in Autonomous     |
| - Milestone Decomposition |                 |   Tool-Calling Runner     |
| - Root Cause Analysis     |                 | - File Operations & Diffs |
| - Corrective Repair Plans |                 | - CLI Adapters (Aider)    |
+-------------+-------------+                 +-------------+-------------+
              ^                                             |
              |               Failed Check Evidence         v
              |          +----------------------------------+
              |          |
+-------------+----------+--+                 +---------------------------+
|   Independent Verifier    |                 |   Target Codebase & Repo  |
| - Native Build Checks     | <============== | - Git Snapshots & Commits |
| - Automated Test Runners  |                 | - Diffs & Sandboxed Run   |
| - Git Diff Audit & Safety |                 +---------------------------+
+---------------------------+
```

---

## 🚀 Key Features

1. **Closed-Loop Implementation & Self-Repair**
   - Automatically executes: **User Request -> Repo Inspection -> LLM Planning -> Agent Execution -> Independent Verification -> Failure Diagnosis -> Automatic Repair -> Reverification -> Completion**.
   - Does not trust the agent's self-assessment; tasks are only completed when independent compiler, test, and git diff verifications pass.

2. **The Brain (Google Gemini)**
   - Formulates step-by-step milestones with explicit acceptance criteria.
   - Performs Root Cause Analysis (RCA) on failed compiler outputs, test traces, and git diffs.
   - Generates targeted corrective repair instructions.

3. **The Engineer (Built-in Autonomous Agent)**
   - Sandboxed tool suite: `readFile`, `writeFile`, `replaceInFile`, `deleteFile`, `listFiles`, `searchCode` (regex/ripgrep), and `executeCommand`.
   - Pluggable adapter interface supporting external CLI agents (e.g. Aider).

4. **Independent Verification Engine**
   - Automatically discovers project ecosystem (`Node/npm`, `Python/pytest`, `Rust/cargo`, `Go`).
   - Runs test suites, builds, and linters independently.
   - Audits Git diffs for test-skipping patterns (`test.skip`) and sensitive file modifications (`.env`).

5. **Persistent Memory & SQLite Task Ledger**
   - Durable SQLite database (`file:orchestrator.db`) tracking tasks, steps, verifications, git commit checkpoints, and approval gates.
   - Ability to rollback to any step snapshot.

6. **Interactive Web Control Dashboard**
   - High-aesthetic real-time web UI built with Vite and React.
   - Real-time WebSocket streaming of terminal logs and lifecycle transitions.
   - State progress visualization, milestone inspector, and git diff viewer.
   - Human approval gate for sensitive operations.

7. **Terminal CLI**
   - Run autonomous missions directly from the terminal or in CI/CD scripts.

---

## 🛠 Quick Start

### 1. Prerequisites
- **Node.js** v20+ / v24+
- **Git**
- *(Optional)* Google Gemini API Key

### 2. Configuration
Copy the template and provide your Gemini API Key:
```bash
cp .env.example .env
```
Edit `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
PORT=4000
MAX_RETRY_BUDGET=3
```

### 3. Start the Server & Web Control Dashboard
```bash
npm start
```
Open **`http://localhost:4000`** in your browser.

### 4. Run via Terminal CLI
```bash
# Run an autonomous task in the current workspace:
npm run cli -- run -p "Implement user authentication middleware and verify tests pass"

# Inspect the current repository metadata and detected verification suites:
npm run cli -- inspect
```

---

## 📁 Repository Layout

```
oRCHESTRATOR/
├── src/
│   ├── config/              # Zod environment validation & policy configurations
│   ├── db/                  # LibSQL / SQLite durable ledger & repository schemas
│   ├── llm/                 # Gemini Brain: Planning, RCA Diagnostics & Review prompts
│   ├── agent/               # Autonomous Coding Agent: tool suite & sandbox execution
│   ├── repo/                # Git inspector, automatic checkpoints & commit rollbacks
│   ├── verifier/            # Independent verification engine (builds, tests, diff audits)
│   ├── orchestrator/        # Closed-loop state machine, repair loop & approval gates
│   ├── server/              # Fastify REST API & real-time WebSocket event broadcaster
│   ├── cli/                 # Commander.js interactive terminal CLI
│   └── index.ts             # Server and engine root entrypoint
├── web/                     # Modern React + Vite Web Control Dashboard
│   ├── src/
│   │   ├── App.tsx          # Real-time dashboard with task list, stepper, logs & diffs
│   │   ├── index.css        # Rich dark glassmorphic styling system
│   │   └── main.tsx
│   └── vite.config.ts       # Reverse proxy configuration
├── dist/                    # Compiled backend distribution
└── orchestrator.db          # Durable SQLite task & verification database
```

---

## 🔒 Security & User Control

- **Workspace Path Sandboxing**: Agent cannot access or modify files outside authorized workspaces.
- **Command Blacklist**: Destructive commands (`rm -rf /`, `format`, `shutdown`, `git push --force`) are intercepted and blocked.
- **Human Approval Gate**: Sensitive actions pause the orchestrator, alert the operator via WebSocket and UI, and require explicit approval before execution.
- **Git Checkpoints**: Automatic commits before and after every step allow one-click rollback if regressions occur.
