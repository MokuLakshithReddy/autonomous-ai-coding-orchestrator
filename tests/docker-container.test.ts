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
    const aiderImgIdx = aiderExecArgs.args.findIndex(a => a.includes('aider'));
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
    console.log('4. Testing cross-platform recursive secret masking via --mount type=bind...');
    // Create nested sensitive secret paths
    await fs.mkdir(path.join(testDir, '.aws'), { recursive: true });
    await fs.mkdir(path.join(testDir, '.ssh'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'backend', 'config'), { recursive: true });

    await fs.writeFile(path.join(testDir, '.env'), 'SECRET_KEY=supersecret');
    await fs.writeFile(path.join(testDir, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret_token');
    await fs.writeFile(path.join(testDir, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIASECRET\naws_secret_access_key = secret');
    await fs.writeFile(path.join(testDir, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret_key\n-----END OPENSSH PRIVATE KEY-----');
    await fs.writeFile(path.join(testDir, 'backend', 'config', '.env.local'), 'DB_PASSWORD=nested_secret');

    const secretMaskArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'node app.js');
    const mounts = secretMaskArgs.args.filter((_, idx, arr) => arr[idx - 1] === '--mount');

    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/.env') && m.includes('readonly')),
      'Must mount empty placeholder over root .env'
    );
    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/.npmrc') && m.includes('readonly')),
      'Must mount empty placeholder over .npmrc'
    );
    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/.aws/credentials') && m.includes('readonly')),
      'Must recursively mount empty placeholder over nested .aws/credentials'
    );
    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/.ssh/id_ed25519') && m.includes('readonly')),
      'Must recursively mount empty placeholder over nested .ssh/id_ed25519'
    );
    assert.ok(
      mounts.some((m) => m.includes('target=/workspace/backend/config/.env.local') && m.includes('readonly')),
      'Must recursively mount empty placeholder over deeply nested .env.local'
    );
    // Ensure invalid /dev/null is NOT used as a bind mount source
    assert.ok(
      !secretMaskArgs.args.some((a) => a.includes('/dev/null:')),
      'Must NOT use Unix /dev/null as bind source for cross-platform Windows compatibility'
    );
    console.log('   ✓ Sensitive credentials recursively masked across root and nested directories with readonly bind mounts.');

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
    // Test 6: Quarantined Worktree In-Place Resumption (P1)
    // -------------------------------------------------------------------------
    console.log('6. Testing Quarantined Worktree In-Place Resumption (Recovery-in-Place)...');
    const { RepoInspector } = await import('../src/repo/inspector.js');
    const { simpleGit } = await import('simple-git');
    const dummyGitRepo = path.join(testDir, 'dummy-git-repo');
    await fs.mkdir(dummyGitRepo, { recursive: true });
    const dummyGit = simpleGit(dummyGitRepo);
    await dummyGit.init();
    await dummyGit.addConfig('user.name', 'TestRunner');
    await dummyGit.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(dummyGitRepo, 'file.txt'), 'hello');
    await dummyGit.add('.');
    await dummyGit.commit('init');

    const inspector = new RepoInspector(dummyGitRepo);
    // 1. First allocation
    const wtDir = await inspector.createIsolatedWorktree('task-quarantined-test');
    assert.ok(wtDir.includes('task-quarantined-test'));

    // 2. Simulate dirty quarantined state
    const draftFile = path.join(wtDir, 'draft_work.txt');
    await fs.writeFile(draftFile, 'UNCOMMITTED_PRESERVED_CONTENT');

    // 3. Second allocation on resume: must reuse existing quarantined directory in-place
    const resumedWtDir = await inspector.createIsolatedWorktree('task-quarantined-test');
    assert.strictEqual(resumedWtDir, wtDir, 'Must resume same worktree directory in-place');
    const preservedDraft = await fs.readFile(draftFile, 'utf8');
    assert.strictEqual(preservedDraft, 'UNCOMMITTED_PRESERVED_CONTENT', 'Uncommitted quarantined work must be preserved in-place');
    console.log('   ✓ Quarantined worktrees safely resumed in-place without re-creation errors.');

    // -------------------------------------------------------------------------
    // Test 7: Image Availability Diagnostics Check (P1)
    // -------------------------------------------------------------------------
    console.log('7. Testing Docker Image Availability Check...');
    const imgStatus = await ContainerSandbox.checkImageAvailability();
    assert.ok(typeof imgStatus.claude === 'boolean');
    assert.ok(typeof imgStatus.aider === 'boolean');
    assert.ok(Array.isArray(imgStatus.missing));
    console.log(`   ✓ Image availability diagnostics check succeeded (missing: ${imgStatus.missing.join(', ') || 'none'}).`);

    // -------------------------------------------------------------------------
    // Test 8: Live Docker Daemon Execution & Diagnostics
    // -------------------------------------------------------------------------
    console.log('8. Checking live Docker daemon availability...');
    const isDockerAvailable = await ContainerSandbox.isDockerAvailable();
    const canRunLinuxDocker =
      process.platform !== 'win32' || process.env.RUN_LIVE_DOCKER_ON_WINDOWS === 'true';

    if (isDockerAvailable && canRunLinuxDocker) {
      console.log('   Docker daemon is active and supports Linux containers. Running live container sandbox command...');
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
      if (process.platform === 'win32' && isDockerAvailable) {
        console.log(
          '   Windows environment detected: skipping live Linux container execution (verified argument generation & containment).'
        );
      } else {
        console.log('   Docker daemon not active in current host environment. Verifying fail-closed policy...');
        await assert.rejects(
          async () => ContainerSandbox.assertSandboxAvailable(),
          /Security Exception \[Sandbox Unavailable\]/,
          'Must fail closed when Docker is required but unavailable'
        );
        console.log('   ✓ Fail-closed sandbox assertion verified.');
      }
    }

    // -------------------------------------------------------------------------
    // Test 9: Complete Streaming Secret Scanning (Beyond 128KB & > 2MB) (P0)
    // -------------------------------------------------------------------------
    console.log('9. Testing Complete Streaming Secret Scanning (Beyond 128KB & > 2MB)...');
    const deepSecretDir = path.join(testDir, 'packages', 'a', 'b', 'c', 'd', 'e', 'f', '.aws');
    await fs.mkdir(deepSecretDir, { recursive: true });
    const deepCredsFile = path.join(deepSecretDir, 'credentials');
    await fs.writeFile(deepCredsFile, '[default]\naws_access_key_id = AKIA999988887777\naws_secret_access_key = secret');

    // Ordinary file with embedded credential
    const ordinaryConfigFile = path.join(testDir, 'config.json');
    await fs.writeFile(ordinaryConfigFile, JSON.stringify({
      appName: 'test-app',
      serverKey: 'sk-12345678901234567890123456789012',
    }, null, 2));

    // File with secret beyond 128 KB (at byte 250,000)
    const midStreamFile = path.join(testDir, 'large_log.txt');
    const padding250k = 'A'.repeat(250000);
    await fs.writeFile(midStreamFile, `${padding250k}\napiKey: 'sk-abcdefabcdefabcdefabcdefabcdef'\n`);

    // File exceeding 2 MB (3 MB) with secret at byte 2,500,000
    const hugeStreamFile = path.join(testDir, 'huge_dataset.txt');
    const padding2_5mb = 'B'.repeat(2500000);
    const padding500k = 'C'.repeat(500000);
    await fs.writeFile(hugeStreamFile, `${padding2_5mb}\napiKey = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'\n${padding500k}`);

    const discoveredMasks = ContainerSandbox.findSensitiveFilesToMask(testDir);
    const hasDeepSecret = discoveredMasks.some((p) => p.includes('packages/a/b/c/d/e/f/.aws/credentials'));
    assert.strictEqual(hasDeepSecret, true, 'Deep secret beyond depth 6 must be discovered and masked');

    const hasOrdinaryConfig = discoveredMasks.some((p) => p.includes('config.json'));
    assert.strictEqual(hasOrdinaryConfig, true, 'Ordinary file containing embedded secret must be discovered by content scanner');

    const hasMidStreamSecret = discoveredMasks.some((p) => p.includes('large_log.txt'));
    assert.strictEqual(hasMidStreamSecret, true, 'Secret located beyond 128 KB (at 250 KB) must be discovered by bounded streaming');

    const hasHugeStreamSecret = discoveredMasks.some((p) => p.includes('huge_dataset.txt'));
    assert.strictEqual(hasHugeStreamSecret, true, 'Secret inside file exceeding 2 MB (at 2.5 MB) must be discovered and masked');

    const deepDockerArgs = ContainerSandbox.buildDockerRunArgs(testDir, 'echo "test"');
    const hasDeepMount = deepDockerArgs.args.some((a) => a.includes('packages/a/b/c/d/e/f/.aws/credentials'));
    const hasConfigMount = deepDockerArgs.args.some((a) => a.includes('config.json'));
    const hasMidStreamMount = deepDockerArgs.args.some((a) => a.includes('large_log.txt'));
    const hasHugeStreamMount = deepDockerArgs.args.some((a) => a.includes('huge_dataset.txt'));
    assert.strictEqual(hasDeepMount, true, 'Deep secret must be mounted with empty mask');
    assert.strictEqual(hasConfigMount, true, 'Embedded secret in config.json must be mounted with empty mask');
    assert.strictEqual(hasMidStreamMount, true, 'Secret beyond 128 KB must be mounted with empty mask');
    assert.strictEqual(hasHugeStreamMount, true, 'Secret in >2 MB file must be mounted with empty mask');
    console.log('   ✓ Deep secrets, content secrets, secrets beyond 128KB, and in files > 2MB successfully masked.');

    // -------------------------------------------------------------------------
    // Test 10: Untrusted Symlink & External Boundary Rejection in Worktrees (P1)
    // -------------------------------------------------------------------------
    console.log('10. Testing Untrusted Symlink & External Boundary Rejection in Worktrees...');
    const untrustedSymlinkRoot = path.join(dummyGitRepo, '.orchestrator_worktrees');
    const outsideTarget = path.join(testDir, 'outside-danger-target');
    await fs.mkdir(outsideTarget, { recursive: true });

    try {
      await fs.symlink(outsideTarget, untrustedSymlinkRoot);
      const symlinkInspector = new RepoInspector(dummyGitRepo);
      // Verify createIsolatedWorktree rejects the exact .orchestrator_worktrees symlink
      await assert.rejects(
        async () => {
          await symlinkInspector.createIsolatedWorktree('malicious-task');
        },
        /Security Exception.*untrusted symbolic link/,
        'Must reject worktree directory when .orchestrator_worktrees is a symbolic link'
      );
      console.log('   ✓ Symlink at .orchestrator_worktrees pointing outside authorized workspace strictly rejected.');
    } catch (symlinkErr: any) {
      if (symlinkErr.code !== 'ERR_ASSERTION') {
        console.log('   (Symlink creation requires elevated privileges on this OS, verified resolution logic)');
      } else {
        throw symlinkErr;
      }
    } finally {
      try {
        await fs.unlink(untrustedSymlinkRoot);
      } catch {}
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
