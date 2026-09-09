import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArtifact } from './build-artifact.mjs';

test('builds a self-contained Worker with a verifiable, reproducible manifest', async () => {
  const out = await mkdtemp(join(tmpdir(), 'nimbalyst-worker-artifact-'));
  try {
    const { manifest, metafile } = await buildArtifact(out);
    const worker = await readFile(join(out, 'worker.mjs'));
    assert.equal(manifest.workerSha256, createHash('sha256').update(worker).digest('hex'));
    const helper = await readFile(join(out, 'rpc-helper.mjs'));
    assert.equal(manifest.helperSha256, createHash('sha256').update(helper).digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')), manifest);
    const outputs = Object.values(metafile.outputs);
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].exports.includes('SandboxManager'));
    assert.ok(outputs[0].exports.includes('NimbalystSandbox'));
    assert.ok(outputs[0].imports.every(({ path }) => /^(cloudflare:|node:)/.test(path)), 'No unresolved npm or local imports may reach the deploy artifact');
    assert.deepEqual((await buildArtifact(out)).manifest, manifest);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
