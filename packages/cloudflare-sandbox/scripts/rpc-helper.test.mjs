import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runManagerRPC } from './rpc-helper.mjs';

test('private control uses explicit config, confirms stop, and disposes after RPC failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-helper-'));
  const configPath = join(dir, 'wrangler.json');
  let opened = 0;
  let disposed = 0;
  const calls = [];
  try {
    await writeFile(configPath, JSON.stringify({
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    }));
    const createProxy = async options => {
      opened++;
      assert.deepEqual(options, { configPath, persist: false, envFiles: [], remoteBindings: true });
      return {
        env: { Manager: {
          status: async () => ({ state: 'stopped' }),
          stop: async request => { calls.push(request); throw new Error('RPC failed'); },
        } },
        dispose: async () => { disposed++; },
      };
    };
    await assert.rejects(runManagerRPC({ configPath, operation: 'stop' }, createProxy), /confirmation/);
    assert.equal(opened, 0);
    assert.deepEqual(await runManagerRPC({ configPath, operation: 'status' }, createProxy), { state: 'stopped' });
    await assert.rejects(runManagerRPC({ configPath, operation: 'stop', discardEphemeralData: true }, createProxy), /RPC failed/);
    assert.deepEqual(calls, [{ discardEphemeralData: true }]);
    assert.equal(disposed, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('child protocol suppresses Wrangler diagnostics without breaking write callbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-protocol-'));
  try {
    const configPath = join(dir, 'wrangler.json');
    const wranglerModulePath = join(dir, 'wrangler-fixture.mjs');
    await writeFile(configPath, JSON.stringify({
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    }));
    await writeFile(wranglerModulePath, `
      await new Promise(resolve => process.stdout.write('synthetic-auth-secret', resolve));
      console.error('synthetic-diagnostic-secret');
      export async function getPlatformProxy() {
        return { env: { Manager: { status: async () => ({ state: 'stopped' }) } }, dispose: async () => {} };
      }
    `);
    const child = execFile(process.execPath, [fileURLToPath(new URL('./rpc-helper.mjs', import.meta.url))], { timeout: 5000 });
    const result = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    child.stdin.end(JSON.stringify({ configPath, wranglerModulePath, operation: 'status' }));
    const output = await result;
    assert.equal(output.code, 0);
    assert.deepEqual(JSON.parse(output.stdout), { success: true, data: { state: 'stopped' } });
    assert.equal(output.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('child failures distinguish expired SSO, missing consent, and invalid config without diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-failures-'));
  try {
    const configPath = join(dir, 'wrangler.json');
    const wranglerModulePath = join(dir, 'wrangler-fixture.mjs');
    const config = {
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(wranglerModulePath, `
      console.error('synthetic-auth-secret');
      export async function getPlatformProxy() {
        throw new Error('Authentication error: synthetic-auth-secret');
      }
    `);
    const callRaw = body => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL('./rpc-helper.mjs', import.meta.url))], { timeout: 5000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(body);
    });
    const call = request => callRaw(JSON.stringify({ configPath, wranglerModulePath, ...request }));
    const expectFailure = (output, error, reason) => {
      assert.equal(output.code, 1);
      assert.deepEqual(JSON.parse(output.stdout), { success: false, error, reason });
      assert.equal(output.stderr, '');
    };
    for (const [request, error, reason] of [
      [{ operation: 'status' }, 'not-authenticated', 'authentication'],
      [{ operation: 'stop' }, 'confirmation-required', 'confirmation-required'],
      [{ operation: 'eval' }, 'unknown', 'invalid-operation'],
    ]) {
      expectFailure(await call(request), error, reason);
    }
    // A body that parses to something other than an object reached a property
    // access and reported `container-unavailable`, blaming the sandbox for our
    // own malformed input.
    for (const body of ['null', '"status"', '{']) {
      expectFailure(await callRaw(body), 'unknown', 'invalid-request');
    }
    // Only unexpected top-level keys were rejected, so a malformed value threw
    // out of validation and was misreported the same way.
    for (const malformed of [
      { ...config, main: 'unreviewed-worker.js' },
      { ...config, services: [null] },
      { ...config, services: 'nimbalyst-sandbox-test' },
      null,
    ]) {
      await writeFile(configPath, JSON.stringify(malformed));
      expectFailure(await call({ operation: 'status' }), 'unknown', 'invalid-config');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
