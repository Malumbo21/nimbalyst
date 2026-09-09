# @nimbalyst/node

Run a Nimbalyst agent session from a plain Node process. No Electron, no renderer, no sync.

This is the first consumer of `@nimbalyst/runtime`'s `node` export condition. It imports only deep `node`-condition subpaths — never the `@nimbalyst/runtime` barrel, which drags in the whole Lexical editor tree and is not emitted into `dist-node/` at all.

## Build from a checkout

Run these commands from the repository root:

```sh
npm ci
npm run build:workspace-deps
npm run build:node --workspace=@nimbalyst/runtime
npm run build --workspace=@nimbalyst/node
```

The Node package builds explicitly after runtime's Node exports and declarations exist. It does not compile during installation, when those artifacts are absent in a clean checkout.

## What it does

```
nimbalyst-node --config ./nimbalyst-node.config.json \
               --workspace /path/to/repo \
               --prompt "list the files in this directory"
```

Creates (or resumes) a session, runs one Claude Code turn against the workspace, streams the output, and persists the transcript to `ai_agent_messages` in a SQLite database with the same schema the desktop app uses.

Add `--session <id>` to continue an existing session. The `providerSessionId` is persisted at the end of every turn and handed back to the SDK on the next one, so a second process resumes the same conversation rather than starting a fresh one.

## Configuration

`--config` is required and has no default. Provider API keys and MCP servers must be explicitly provisioned in that file. The agent child receives only OS/runtime environment locations plus Nimbalyst's managed options; ambient provider keys and endpoint overrides are excluded. CLI OAuth login can still use the current user's credential store.

```json
{
  "databasePath": "./data/nimbalyst.sqlite",
  "trust": { "mode": "bypass-all" }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `databasePath` | yes | SQLite file. Relative paths resolve against the config file's directory. |
| `schemaDir` | no | Migration directory. Defaults to the in-repo copy under `packages/electron`. |
| `claudeCodePath` | no | Explicit `claude` executable. Otherwise the SDK's bundled native binary is resolved. |
| `providerApiKeys` | no | Explicitly-provisioned credentials by provider id. Claude Code needs none. |
| `trust.mode` | yes | Explicit `bypass-all`. Missing, invalid, `ask`, and `allow-all` policies are rejected before opening the database; the latter two need a permission responder. |
| `mcpServers` | no | Explicit MCP server map; defaults to no external servers. Provision literal values: unexpanded `${...}` references are rejected with the server and field name, never expanded against the host environment. |

`trust.mode` grants the agent the operating-system user's permissions. `--workspace` sets the working directory; it does not confine file access. Use a disposable isolated environment for untrusted repositories, and keep unrelated workspaces and privileged credentials outside it.

Headless runs disable implicit MCP discovery and user/project/local settings sources, including executable repository hooks and automatic `CLAUDE.md` project-instruction loading. The SDK also receives `skills: []`, `agents: {}`, and `plugins: []`; Nimbalyst's extension plugin loader is skipped. Only the `mcpServers` map you provision is supplied to the SDK. Desktop configuration discovery is unaffected.

## Schema

The DDL is **not** restated in this package. `db/migrations.ts` reads the same numbered `.sql` files `packages/electron`'s `MigrationRunner` reads, applies them through an identical `_migrations` ledger, and `src/__tests__/migrations.test.ts` asserts the derived list matches `getMigrations()` exactly — so the day someone adds a non-file migration this fails here rather than producing a database that is silently a version behind.

Those files currently live only inside the Electron app package, which means an installed copy of this package must be handed a `schemaDir`. Extracting the schema into a package both hosts depend on is the fix, and it is not in scope for phase 0.

## Not in scope

Personal sync. There is no `SyncedSessionStore`, no index room, and nothing streams to the phone.
