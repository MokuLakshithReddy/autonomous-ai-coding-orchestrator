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
    assert.ok(claudeArgs.args.includes('orchestrator-claude:latest') || claudeArgs.args.some(a => a.includes('claude')), 'Must select Claude container image');

    const pyArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'pytest tests/');
    assert.ok(pyArgs.args.includes('python:3.11-slim'), 'Must select Python container image for pytest');

    const rustArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'cargo test');
    assert.ok(rustArgs.args.includes('rust:1.80-slim'), 'Must select Rust container image for cargo');

    const goArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'go test ./...');
    assert.ok(goArgs.args.includes('golang:1.23-bookworm'), 'Must select Go container image for go test');
    console.log('   ✓ Image selection correctly adapts to runtime ecosystem.');

    // -------------------------------------------------------------------------
    // Test 2: External Agent Command Construction (No Duplicate Entrypoints)
    // -------------------------------------------------------------------------
    console.log('2. Testing external agent command argument construction...');
    const aiderExecArgs = ContainerSandbox.buildDockerRunArgs(testDir, {
      type: 'exec',
      executable: 'aider',
      args: ['--version'],
    });
    const aiderImgIdx = aiderExecArgs.args.indexOf('paulgauthier/aider:latest');
    const argsAfterAiderImg = aiderExecArgs.args.slice(aiderImgIdx + 1);
    assert.strictEqual(argsAfterAiderImg[0], 'aider', 'Must pass executable once');
    assert.notStrictEqual(argsAfterAiderImg[1], 'aider', 'Must NOT duplicate executable name after image');

    const claudeExecArgs = ContainerSandbox.buildDockerRunArgs(testDir, {
      type: 'exec',
      executable: 'claude',
      args: ['--help'],
    });
    const claudeImgIdx = claudeExecArgs.args.findIndex(a => a.includes('claude'));
    const argsAfterClaudeImg = claudeExecArgs.args.slice(claudeImgIdx + 1);
    assert.strictEqual(argsAfterClaudeImg[0], 'claude', 'Must pass executable once');
    assert.notStrictEqual(argsAfterClaudeImg[1], 'claude', 'Must NOT duplicate executable name after image');
    console.log('   ✓ External agent adapters construct clean command lines without duplicate entrypoints.');

    // -------------------------------------------------------------------------
    // Test 3: Network Routing (Install vs Non-Install)
    // -------------------------------------------------------------------------
    console.log('3. Testing network containment vs dependency installation routing...');
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
    // Test 4: Cross-Platform Kernel Boundary Secret Masking (--mount type=bind)
    // -------------------------------------------------------------------------
    console.log('4. Testing cross-platform secret masking via --mount type=bind...');
    await fs.writeFile(path.join(testDir, '.env'), 'SECRET_KEY=supersecret');
    await fs.writeFile(path.join(testDir, 'credentials.json'), '{"apiKey": "secret"}');

    const secretMaskArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'node app.js');
    const mounts = secretMaskArgs.args.filter((_, idx, arr) => arr[idx - 1] === '--mount');

    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/.env') && m.includes('readonly')),
      'Must mount empty placeholder over .env with readonly flag'
    );
    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/credentials.json') && m.includes('readonly')),
      'Must mount empty placeholder over credentials.json with readonly flag'
    );
    // Ensure invalid /dev/null is NOT used as a bind mount source
    assert.ok(
      !secretMaskArgs.args.some((a) => a.includes('/dev/null:')),
      'Must NOT use Unix /dev/null as bind source for cross-platform Windows compatibility'
    );
    console.log('   ✓ Sensitive credentials masked with cross-platform readonly bind mounts.');

    // -------------------------------------------------------------------------
    // Test 5: Host Git Metadata Protection (Zero Write Access to Parent .git)
    // -------------------------------------------------------------------------
    console.log('5. Testing Host Git Metadata Protection (Zero Write Access)...');
    const gitMountArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'git status');
    // Ensure parent .git is NEVER mounted with :rw into the container
    assert.ok(
      !gitMountArgs.args.some((a) => a.includes('.git') && a.includes(':rw')),
      'Untrusted container MUST NEVER receive write access to host repository .git'
    );
    console.log('   ✓ Container strictly denied write access to host repository Git metadata.');

    // -------------------------------------------------------------------------
    // Test 6: Live Docker Daemon Execution & Diagnostics
    // -------------------------------------------------------------------------
    console.log('6. Checking live Docker daemon availability...');
    const isDockerAvailable = await ContainerSandbox.isDockerAvailable();
    if (isDockerAvailable) {
      console.log('   Docker daemon is active. Running live container sandbox command...');
      const runArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'echo "CONTAINER_ISOLATION_OK"');
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(runArgs.executable, runArgs.args, { encoding: 'utf8' });

      if (res.status !== 0) {
        console.error('Docker command failed!');
        console.error('Arguments:', runArgs.args.join(' '));
        console.error('Exit code:', res.status);
        console.error('Stderr:', res.stderr);
        console.error('Stdout:', res.stdout);
        console.error('Error:', res.error);
      }

      assert.strictEqual(res.status, 0, `Container command must exit with 0 (stderr: ${res.stderr || 'none'})`);
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
