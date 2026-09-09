// @vitest-environment node
import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    sleepAfter = '10m';
    enableInternet = true;
    getState = vi.fn(async () => ({ status: 'stopped', lastChange: 12 }));
    exec = vi.fn(async () => ({ success: true }));
    stop = vi.fn(async () => {});
    setSandboxName = vi.fn(async () => {});
    setKeepAlive = vi.fn(async () => {});
    setSleepAfter = vi.fn(async () => {});
  },
}));
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(_ctx: unknown, public env: unknown) {}
  },
}));

import worker, { NimbalystSandbox, SandboxManager } from '../index';

describe('private Worker entrypoints', () => {
  it('has no HTTP management route and enforces the management runtime policy', async () => {
    expect((await worker.fetch()).status).toBe(404);
    const sandbox = new NimbalystSandbox({} as never, {} as never);
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.sleepAfter).toBe('300s');
    expect(await sandbox.managedStatus()).toMatchObject({ state: 'stopped', sleepAfterSeconds: 300 });
    expect(sandbox.exec).not.toHaveBeenCalled();
    await sandbox.managedWake();
    expect(sandbox.setKeepAlive).toHaveBeenCalledWith(false);
    expect(sandbox.setSleepAfter).toHaveBeenCalledWith(300);
    expect(sandbox.exec).toHaveBeenCalledWith('/opt/nimbalyst/bin/nimbalyst-node --smoke', { timeout: 30_000 });
    expect(sandbox.setSandboxName).toHaveBeenCalledWith('personal');

    // A container that is up is not a runtime that works, so the smoke result is
    // the only evidence a wake succeeded. Failing it must surface as an error
    // and must not discard the container: that would lose files without consent.
    (sandbox.exec as unknown as Mock).mockResolvedValueOnce({ success: false });
    await expect(sandbox.managedWake()).rejects.toThrow(/headless node runtime check failed/);
    expect(sandbox.stop).not.toHaveBeenCalled();

    const getByName = vi.fn(() => sandbox);
    const manager = new SandboxManager({} as never, { Sandbox: { getByName } } as never);
    await manager.status();
    expect(getByName).toHaveBeenCalledWith('personal');
    await expect(manager.stop({})).rejects.toThrow('requires confirmation');
    expect(sandbox.stop).not.toHaveBeenCalled();
    await manager.stop({ discardEphemeralData: true });
    expect(sandbox.stop).toHaveBeenCalledWith('SIGTERM');
  });
});
