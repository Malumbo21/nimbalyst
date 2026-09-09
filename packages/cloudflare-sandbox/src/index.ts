import { Sandbox } from '@cloudflare/sandbox';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { SANDBOX_ID, SLEEP_AFTER_SECONDS, SandboxManagement } from './management';

export interface Env {
  Sandbox: DurableObjectNamespace<NimbalystSandbox>;
}

export class NimbalystSandbox extends Sandbox<Env> {
  override sleepAfter = `${SLEEP_AFTER_SECONDS}s`;
  // Management needs no external network. Credential provisioning and provider
  // execution must introduce an explicit egress policy before enabling it.
  override enableInternet = false;

  private readonly management = new SandboxManagement({
    getState: () => this.getState(),
    checkRuntime: async () => {
      await this.setSandboxName(SANDBOX_ID);
      await this.setKeepAlive(false);
      await this.setSleepAfter(SLEEP_AFTER_SECONDS);
      const result = await this.exec('/opt/nimbalyst/bin/nimbalyst-node --smoke', { timeout: 30_000 });
      if (!result.success) throw new Error('The sandbox started, but the headless node runtime check failed.');
    },
    stop: () => this.stop('SIGTERM'),
  });

  managedStatus() { return this.management.status(); }
  managedWake() { return this.management.wake(); }
  managedStop(request: unknown) { return this.management.stop(request); }
}

/** Available only through an account-authorized service binding, never HTTP. */
export class SandboxManager extends WorkerEntrypoint<Env> {
  status() { return this.env.Sandbox.getByName(SANDBOX_ID).managedStatus(); }
  wake() { return this.env.Sandbox.getByName(SANDBOX_ID).managedWake(); }
  stop(request: unknown) { return this.env.Sandbox.getByName(SANDBOX_ID).managedStop(request); }
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
} satisfies ExportedHandler<Env>;
