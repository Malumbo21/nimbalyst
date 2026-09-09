import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildArtifact(outDir = resolve(packageRoot, 'dist')) {
  const release = JSON.parse(await readFile(resolve(packageRoot, 'release.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(resolve(packageRoot, 'node_modules/@cloudflare/sandbox/package.json'), 'utf8'));
  if (release.schemaVersion !== 1 || release.sdkVersion !== pkg.dependencies['@cloudflare/sandbox'] || installed.version !== release.sdkVersion) {
    throw new Error('The Worker SDK and image release must use the same pinned version.');
  }
  // An unpublished build is useful for local validation, but cannot be deployed.
  // Never substitute the upstream base image: it lacks our headless runtime.
  if (release.image !== null && !/^docker\.io\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(release.image)) {
    throw new Error('The release image must be a Docker Hub repository pinned by sha256 digest.');
  }
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    metafile: true,
    sourcemap: false,
    legalComments: 'inline',
  });
  const worker = result.outputFiles[0].contents;
  const helper = await readFile(resolve(packageRoot, 'scripts/rpc-helper.mjs'));
  const manifest = {
    schemaVersion: 1,
    sdkVersion: release.sdkVersion,
    workerSha256: createHash('sha256').update(worker).digest('hex'),
    helperSha256: createHash('sha256').update(helper).digest('hex'),
    image: release.image,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'worker.mjs'), worker);
  await writeFile(resolve(outDir, 'rpc-helper.mjs'), helper);
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, metafile: result.metafile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { manifest } = await buildArtifact();
  console.log(`Built private Sandbox Worker ${manifest.workerSha256}; image ${manifest.image ?? 'not published (deployment disabled)'}`);
}
