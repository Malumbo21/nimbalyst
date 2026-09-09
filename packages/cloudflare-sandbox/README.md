# Cloudflare sandbox management

This package supplies a private management Worker deployed into the user's Cloudflare account. Nimbalyst's Settings panel uses their local Wrangler named SSO profile and requires an explicit account choice. The application does not request or store Cloudflare API keys. Local end-to-end tests run on the host; Docker is used only to build and smoke-test the headless Linux image.

The current slice manages one sandbox per installation: review a deployment, deploy, observe status, wake, stop, and delete. Deployment success and container readiness are separate observations. Idle sleep is five minutes, with at most one `standard-3` instance. Files and processes inside the sandbox are ephemeral; stop and idle sleep lose them. This does not yet deliver mobile pairing, personal synchronization, provider credential forwarding, or remote agent execution. External network access is disabled in this initial management Worker.

## Deployment artifacts

Install this isolated package with `npm ci --prefix packages/cloudflare-sandbox --workspaces=false --ignore-scripts`, then run `npm run build --prefix packages/cloudflare-sandbox`. Electron packaging performs both steps automatically. The generated `dist/worker.mjs` bundles the pinned Sandbox SDK; `dist/manifest.json` binds its SHA-256 to the release image. No project directory or dependency installation is sent to Cloudflare by the desktop flow.

`release.json` deliberately has `image: null` until a tested Nimbalyst Linux image is published. This makes the artifact buildable for local validation while deployment remains unavailable. After an approved publication, set its image to the resulting immutable `docker.io/<organization>/<repository>@sha256:<digest>` reference, keep its Sandbox SDK version aligned with the image, and rebuild. Never substitute the upstream Sandbox base image: it does not contain the Nimbalyst headless runner. Building an image locally is not publication or Cloudflare acceptance.

Cloudflare supports registry image deployment without a local Docker daemon. See [Cloudflare container deployment](https://developers.cloudflare.com/containers/guides/deploy/) and [Sandbox deployment](https://developers.cloudflare.com/sandbox/guides/deploy/). Wrangler deploys the Worker before processing container configuration, so failures can leave partial resources. The desktop must preserve their identity for recovery and deletion.

The deployment config uses an explicit account ID, disables `workers.dev` and preview URLs, and exposes the named `SandboxManager` entrypoint only over a service binding. Its HTTP handler returns 404. A private deployment intentionally has no public URL. Management calls must run through the selected Wrangler profile's owned directory binding and explicit account configuration; a CLI profile flag alone is insufficient for Wrangler's remote binding authentication.

## Local validation

Run `npm run typecheck --prefix packages/cloudflare-sandbox`, `npm run test:artifact --prefix packages/cloudflare-sandbox`, and the focused Worker tests from the repository Vitest runner. The artifact check compiles the actual Worker, verifies its exported entrypoints and bundled dependencies, and confirms deterministic bytes and manifest hashes. Linux image build and smoke instructions are in [container/README.md](container/README.md). None of these checks proves a live Cloudflare deployment.
