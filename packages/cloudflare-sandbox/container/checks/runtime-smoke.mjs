/** Linux image acceptance only; no desktop E2E, host mounts, published ports or credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
assert.ok(image && !image.startsWith('-'), 'pass a local image name or digest');
const name = `nimbalyst-image-smoke-${randomUUID()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
try {
  // Deliberately WITHOUT --cap-drop=ALL and --security-opt=no-new-privileges.
  // Cloudflare does not apply those to our container, so a harness that sets
  // them is not measuring the image -- it is measuring the harness. They
  // previously hid a launcher that never set no_new_privs on the path the image
  // actually takes. --network=none stays: that one the image genuinely relies
  // on, and the checks below need no egress.
  docker('run', '--pull=never', '--platform=linux/amd64', '--detach', '--name', name, '--network=none', image);
  // Inspect the real server process, not merely the runner's own UID.
  const status = docker('exec', name, 'cat', '/proc/1/status');
  assert.equal(status.match(/^Uid:\s+(.+)$/m)?.[1].trim().split(/\s+/).join(','), '10001,10001,10001,10001', 'the control service must run as uid 10001');
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (docker('logs', name).includes('Container server started')) { ready = true; break; }
    if (docker('inspect', '--format', '{{.State.Running}}', name).trim() !== 'true') break;
    await delay(500);
  }
  assert.ok(ready, 'the inherited Sandbox entrypoint must become ready without root');
  const smoke = docker('exec', '--env', 'NIMBALYST_SMOKE_ENV_SENTINEL=synthetic-marker', name, '/opt/nimbalyst/bin/nimbalyst-node', '--smoke');
  assert.ok(smoke.includes('[smoke] all checks passed'), smoke);
  // The runner reads its own /proc/self/status; this asserts the line it
  // reported, so a smoke build that silently lost the check cannot pass here.
  assert.match(smoke, /\[smoke\] ok\s+no new privs -- NoNewPrivs 1/, 'the runner must run with no_new_privs set');
  process.stdout.write(smoke);

  // No setuid/setgid binary anywhere on the image's own filesystem. With
  // no_new_privs the runner cannot use one, but the control server and any
  // shell the agent spawns are not covered by that, so the bits are stripped at
  // build time and re-counted here against the real image.
  const suid = docker('exec', name, 'sh', '-c', 'find / -xdev -perm /6000 -type f 2>/dev/null | wc -l').trim();
  assert.equal(suid, '0', `expected no setuid/setgid files in the image, found ${suid}`);
  process.stdout.write(`[image] setuid/setgid files: ${suid}\n`);
  // Exercise the same fixed readiness command through the server, rather than
  // proving only that Docker can start the runner independently of that server.
  const apiSmoke = docker('exec', name, '/opt/nimbalyst/node/bin/node', '--input-type=module', '-e', `
    async function post(path, body) {
      const response = await fetch('http://127.0.0.1:3000' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(JSON.stringify(result));
      return result;
    }
    await post('/api/session/create', { id: 'readiness-smoke', cwd: '/workspace' });
    const result = await post('/api/execute', {
      sessionId: 'readiness-smoke', command: '/opt/nimbalyst/bin/nimbalyst-node --smoke', timeoutMs: 30000,
    });
    if (result.exitCode !== 0 || !result.stdout?.includes('[smoke] all checks passed')) throw new Error(JSON.stringify(result));
    console.log('[image] Sandbox API readiness command passed');
  `);
  process.stdout.write(apiSmoke);
  process.stdout.write('[image] control service uid 10001; rootless startup and runner smoke passed\n');
} finally {
  // Unconditional. Tracking "did docker run return" left a container behind
  // whenever the run succeeded but the client call reporting it did not -- a
  // timeout, a broken pipe -- which is exactly when a leaked container is least
  // expected. The name is a fresh uuid, so removing one that was never created
  // is a no-op, and its "No such container" is the only error swallowed here.
  try {
    docker('rm', '--force', name);
  } catch (error) {
    if (!/No such container/i.test(String(error.stderr ?? error.message ?? ''))) throw error;
  }
}
