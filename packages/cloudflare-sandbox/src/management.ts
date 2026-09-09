export const SANDBOX_ID = 'personal';
export const SLEEP_AFTER_SECONDS = 300;

export type ContainerState = {
  status: 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code';
  lastChange: number;
  exitCode?: number;
};

export interface SandboxStatus {
  sandboxId: string;
  state: ContainerState['status'];
  lastChangedAt: number;
  sleepAfterSeconds: number;
  persistence: 'ephemeral';
}

export interface SandboxPort {
  getState(): Promise<ContainerState>;
  checkRuntime(): Promise<void>;
  stop(): Promise<void>;
}

/** Serialize lifecycle mutations on the sandbox DO, including across callers. */
export class SandboxManagement {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly sandbox: SandboxPort) {}

  async status(): Promise<SandboxStatus> {
    // Checking state must never execute a command or keep an idle container awake.
    const state = await this.sandbox.getState();
    return {
      sandboxId: SANDBOX_ID,
      state: state.status,
      lastChangedAt: state.lastChange,
      sleepAfterSeconds: SLEEP_AFTER_SECONDS,
      persistence: 'ephemeral',
    };
  }

  wake(): Promise<SandboxStatus> {
    return this.serialize(async () => {
      await this.sandbox.checkRuntime();
      return this.status();
    });
  }

  stop(request: unknown): Promise<SandboxStatus> {
    if (!request || typeof request !== 'object'
      || (request as { discardEphemeralData?: unknown }).discardEphemeralData !== true) {
      return Promise.reject(new Error('Stopping requires confirmation that ephemeral files and processes will be lost.'));
    }
    return this.serialize(async () => {
      await this.sandbox.stop();
      // A sent signal is not evidence the container stopped. Preserve observed state.
      return this.status();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
