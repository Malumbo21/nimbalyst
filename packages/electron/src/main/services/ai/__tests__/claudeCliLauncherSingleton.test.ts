import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('claudeCliLauncherSingleton', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadHarness() {
    const manager = {
      isTerminalActive: vi.fn(() => false),
    };
    const stateManager = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      updateActivity: vi.fn(async () => undefined),
    };
    const launch = vi.fn(async (_input?: any): Promise<void> => undefined);

    vi.doMock('../../TerminalSessionManager', () => ({
      getTerminalSessionManager: () => manager,
    }));
    vi.doMock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
      getSessionStateManager: () => stateManager,
    }));
    vi.doMock('@nimbalyst/runtime/ai/server', () => ({
      McpConfigService: class {
        getMcpServersConfig = vi.fn(async () => ({}));
      },
    }));
    vi.doMock('../../CLIManager', () => ({
      getEnhancedPath: () => '/bin',
      getShellEnvironment: () => ({}),
    }));
    vi.doMock('../claudeExecutableResolver', () => ({
      resolveClaudeExecutablePath: () => '/usr/local/bin/claude',
    }));
    vi.doMock('../claudeCliPermissionHookPath', () => ({
      resolveClaudePermissionHookScriptPath: () => undefined,
    }));
    vi.doMock('../claudeCliObservationSingleton', () => ({
      startClaudeCliProxyObservation: vi.fn(),
      fireClaudeCliTurnCompletion: vi.fn(),
    }));
    vi.doMock('../claudeCliQueueFlushSingleton', () => ({
      flushNextClaudeCliQueuedPromptForSession: vi.fn(async () => false),
    }));
    vi.doMock('../ClaudeCliSessionLauncher', () => ({
      ClaudeCliSessionLauncher: class {
        constructor() {
          (this as any).launch = launch;
        }
      },
    }));

    const mod = await import('../claudeCliLauncherSingleton');
    return { ...mod, manager, stateManager, launch };
  }

  it('coalesces concurrent ensure calls for the same session', async () => {
    const h = await loadHarness();
    let releaseLaunch: (() => void) | undefined;
    h.launch.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      }),
    );

    const input = { sessionId: 'session-1', workspacePath: '/work' };
    const first = h.ensureClaudeCliSession(input);
    const second = h.ensureClaudeCliSession(input);
    await Promise.resolve();

    expect(h.stateManager.startSession).toHaveBeenCalledTimes(1);
    expect(h.launch).toHaveBeenCalledTimes(1);

    releaseLaunch?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
  });

  it('ends session state when the launched CLI terminal exits', async () => {
    const h = await loadHarness();
    let onExit: ((exitCode: number) => void) | undefined;
    h.launch.mockImplementationOnce(async (input: { onExit?: (exitCode: number) => void }) => {
      onExit = input.onExit;
    });

    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });
    onExit?.(7);

    expect(h.stateManager.endSession).toHaveBeenCalledWith('session-1');
  });
});
