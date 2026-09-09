// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SandboxManagement, type ContainerState } from '../management';

function fixture() {
  const state: ContainerState = { status: 'stopped', lastChange: 123 };
  const port = {
    getState: vi.fn(async () => state),
    checkRuntime: vi.fn(async () => { state.status = 'healthy'; }),
    stop: vi.fn(async () => { state.status = 'stopping'; }),
  };
  return { state, port, manager: new SandboxManagement(port) };
}

describe('sandbox management', () => {
  it('observes status without waking or extending the idle lifetime', async () => {
    const { manager, port } = fixture();
    expect(await manager.status()).toMatchObject({ state: 'stopped', persistence: 'ephemeral' });
    expect(port.checkRuntime).not.toHaveBeenCalled();
    expect(port.stop).not.toHaveBeenCalled();
  });

  it('requires explicit discard confirmation and reports a stop still in progress honestly', async () => {
    const { manager, port } = fixture();
    for (const request of [undefined, null, {}, { discardEphemeralData: 'true' }]) {
      await expect(manager.stop(request)).rejects.toThrow('requires confirmation');
    }
    expect(port.stop).not.toHaveBeenCalled();
    expect(await manager.stop({ discardEphemeralData: true })).toMatchObject({ state: 'stopping' });
  });

  it('orders a stop after an in-flight wake and recovers after a failed operation', async () => {
    const { manager, port } = fixture();
    let release!: () => void;
    port.checkRuntime.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const waking = manager.wake();
    await Promise.resolve();
    const stopping = manager.stop({ discardEphemeralData: true });
    expect(port.stop).not.toHaveBeenCalled();
    release();
    await waking;
    await stopping;
    expect(port.stop).toHaveBeenCalledOnce();
    port.checkRuntime.mockRejectedValueOnce(new Error('startup failed'));
    await expect(manager.wake()).rejects.toThrow('startup failed');
    expect(await manager.wake()).toMatchObject({ state: 'healthy' });
  });
});
