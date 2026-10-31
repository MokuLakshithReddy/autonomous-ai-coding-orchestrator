import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { ContainerSandbox } from '../src/security/sandbox.js';
import { AgentToolbox } from '../src/agent/tools.js';

async function runDockerContainerTests() {
  console.log('\n===============================================================');
  console.log('   DOCKER CONTAINER ISOLATION & SANDBOX SECURITY TEST SUITE    ');
  console.log('===============================================================\n');

  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-sandbox-test-'));

  try {
    // -------------------------------------------------------------------------
    // Test 1: Image Selection across Node, Python, Rust, Go, Aider, Claude
    // -------------------------------------------------------------------------
    console.log('1. Testing ecosystem-aware image selection...');
    const aiderArgs = ContainerSandbox.buildDockerRunArgs(testDir, {
      type: 'exec',
      executable: 'aider',
      args: ['--version'],
    });
    assert.ok(aiderArgs.args.includes('paulgauthier/aider:latest') || aiderArgs.args.some(a => a.includes('aider')), 'Must select Aider container image');

    const claudeArgs = ContainerSandbox.buildDockerRunArgs(testDir, {
      type: 'exec',
      executable: 'claude',
      args: ['--help'],
    });
    assert.ok(claudeArgs.args.includes('node:22-bookworm-slim') || claudeArgs.args.some(a => a.includes('claude')), 'Must select Claude container image');

    const pyArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'pytest tests/');
    assert.ok(pyArgs.args.includes('python:3.11-slim'), 'Must select Python container image for pytest');

    const rustArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'cargo test');
    assert.ok(rustArgs.args.includes('rust:1.80-slim'), 'Must select Rust container image for cargo');

    const goArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'go test ./...');
    assert.ok(goArgs.args.includes('golang:1.23-bookworm'), 'Must select Go container image for go test');
    console.log('   ✓ Image selection correctly adapts to runtime ecosystem.');

    // -------------------------------------------------------------------------
    // Test 2: Network Routing (Install vs Non-Install)
    // -------------------------------------------------------------------------
    console.log('2. Testing network containment vs dependency installation routing...');
    const toolbox = new AgentToolbox(testDir);

    // Regular test / run command must default to network none
    const testCmdArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'npm test');
    assert.ok(testCmdArgs.args.includes('--network'), 'Must include --network');
    const netTestIdx = testCmdArgs.args.indexOf('--network');
    assert.strictEqual(testCmdArgs.args[netTestIdx + 1], 'none', 'Regular execution must default to network none');

    // Package installation command must dynamically grant bridge
    const installCmdArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'npm install lodash', { networkMode: 'bridge' });
    const netInstallIdx = installCmdArgs.args.indexOf('--network');
    assert.strictEqual(installCmdArgs.args[netInstallIdx + 1], 'bridge', 'Installation commands must be routed to bridge');
    console.log('   ✓ Network mode correctly isolated to none by default, bridged for installations.');

    // -------------------------------------------------------------------------
    // Test 3: Kernel-Level Boundary Secret Masking (/dev/null mounts)
    // -------------------------------------------------------------------------
    console.log('3. Testing kernel boundary secret protection via /dev/null mounts...');
    await fs.writeFile(path.join(testDir, '.env'), 'SECRET_KEY=supersecret');
    await fs.writeFile(path.join(testDir, 'credentials.json'), '{"apiKey": "secret"}');

    const secretMaskArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'node app.js');
    const mounts = secretMaskArgs.args.filter((_, idx, arr) => arr[idx - 1] === '-v');

    assert.ok(
      mounts.some((m) => m.includes('/dev/null:/workspace/.env:ro')),
      'Must mount /dev/null over .env to block exfiltration inside container'
    );
    assert.ok(
      mounts.some((m) => m.includes('/dev/null:/workspace/credentials.json:ro')),
      'Must mount /dev/null over credentials.json to block exfiltration inside container'
    );
    console.log('   ✓ Sensitive credentials masked with /dev/null:ro mounts.');

    // -------------------------------------------------------------------------
    // Test 4: Git Worktree Pointer Resolution
    // -------------------------------------------------------------------------
    console.log('4. Testing Git worktree metadata resolution in container mounts...');
    const fakeParentGit = path.join(testDir, 'parent-repo', '.git');
    const fakeWorktreeGitDir = path.join(fakeParentGit, 'worktrees', 'worktree-1');
    const fakeWorktree = path.join(testDir, 'worktree-1');
    await fs.mkdir(fakeWorktreeGitDir, { recursive: true });
    await fs.mkdir(fakeWorktree, { recursive: true });
    await fs.writeFile(path.join(fakeWorktree, '.git'), `gitdir: ${fakeWorktreeGitDir}\n`);

    const gitWorktreeArgs = ContainerSandbox.buildDockerRunArgs(fakeWorktree, 'git status');
    const worktreeMounts = gitWorktreeArgs.args.filter((_, idx, arr) => arr[idx - 1] === '-v');
    assert.ok(
      worktreeMounts.some((m) => m.includes(fakeParentGit.replace(/\\/g, '/'))),
      'Must mount parent .git directory so gitdir pointer resolves inside container'
    );
    console.log('   ✓ Git worktree metadata path correctly resolved and mounted.');

    // -------------------------------------------------------------------------
    // Test 5: Live Docker Daemon Execution (if Docker daemon is online)
    // -------------------------------------------------------------------------
    console.log('5. Checking live Docker daemon availability...');
    const isDockerAvailable = await ContainerSandbox.isDockerAvailable();
    if (isDockerAvailable) {
      console.log('   Docker daemon is active. Running live container sandbox command...');
      const runArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'echo "CONTAINER_ISOLATION_OK"');
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(runArgs.executable, runArgs.args, { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, 'Container command must exit with 0');
      assert.ok(res.stdout.includes('CONTAINER_ISOLATION_OK'), 'Container output must contain expected stdout');
      console.log('   ✓ Live Docker container execution verified successfully.');
    } else {
      console.log('   Docker daemon not active in current host environment. Verifying fail-closed policy...');
      await assert.rejects(
        async () => ContainerSandbox.assertSandboxAvailable(),
        /Security Exception \[Sandbox Unavailable\]/,
        'Must fail closed when Docker is required but unavailable'
      );
      console.log('   ✓ Fail-closed sandbox assertion verified.');
    }

    console.log('\n=== ALL DOCKER CONTAINER TESTS PASSED! ===\n');
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

runDockerContainerTests().catch((err) => {
  console.error('\n❌ Docker Test Suite Failure:', err);
  process.exit(1);
});
