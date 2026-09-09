// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type LoadedConfig } from '../config.js';

vi.mock('../db/openDatabase.js', () => ({ openDatabase: vi.fn() }));
vi.mock('../host/nodeHost.js', () => ({ registerNodeHostEnvironment: vi.fn() }));
vi.mock('../host/claudeCodeDeps.js', () => ({ registerClaudeCodeDeps: vi.fn() }));
vi.mock('../store/NodeSessionStore.js', () => ({ createNodeSessionStore: vi.fn() }));
vi.mock('../store/NodeAgentMessagesStore.js', () => ({ createNodeAgentMessagesStore: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionManager', () => ({ SessionManager: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider', () => ({ ClaudeCodeProvider: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { setStore: vi.fn() } }));

import { NimbalystNode } from '../NimbalystNode.js';
import { openDatabase } from '../db/openDatabase.js';

describe('headless execution policy', () => {
  it.each([undefined, null, {}, { mode: 'ask' }, { mode: 'allow-all' }, { mode: 'typo' }])('rejects programmatic trust %j before opening the database', async (trust) => {
    vi.mocked(openDatabase).mockClear();
    const config = { databasePath: './agent.sqlite', resolvedDatabasePath: '/unused/agent.sqlite', configPath: '/unused/config.json', trust } as LoadedConfig;
    await expect(NimbalystNode.open(config)).rejects.toThrow(/trust/);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('accepts only an object for provisioned mcpServers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-config-'));
    const file = join(directory, 'config.json');
    const base = { databasePath: './agent.sqlite', trust: { mode: 'bypass-all' } };
    try {
      for (const mcpServers of [null, [], ['server'], 'server', 1, true]) {
        writeFileSync(file, JSON.stringify({ ...base, mcpServers }));
        expect(() => loadConfig(file)).toThrow(/mcpServers must be an object/);
      }
      for (const mcpServers of [undefined, {}, { provisioned: { command: 'node', args: ['server.js'] } }]) {
        writeFileSync(file, JSON.stringify({ ...base, mcpServers }));
        expect(loadConfig(file).mcpServers).toEqual(mcpServers);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit supported noninteractive policy before accepting configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-config-'));
    const file = join(directory, 'config.json');
    try {
      for (const trust of [undefined, null, {}, { mode: 'ask' }, { mode: 'allow-all' }, { mode: 'typo' }]) {
        writeFileSync(file, JSON.stringify({ databasePath: './agent.sqlite', trust }));
        expect(() => loadConfig(file)).toThrow(/trust/);
      }
      writeFileSync(file, JSON.stringify({ databasePath: './agent.sqlite', trust: { mode: 'bypass-all' } }));
      expect(loadConfig(file).trust).toEqual({ mode: 'bypass-all' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
