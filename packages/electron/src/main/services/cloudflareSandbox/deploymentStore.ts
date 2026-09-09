/**
 * The saved record of this installation's sandbox deployment.
 *
 * Only non-secret metadata is persisted: which profile and account it belongs
 * to, the Worker name, when it was deployed. No token, no account credential,
 * nothing that could be replayed if the file were copied.
 *
 * Its own electron-store instance rather than a key in the shared app settings
 * registry, so this slice owns its file outright and does not contend with
 * other sessions over a central schema.
 *
 * `revision` is what makes lifecycle requests safe. It changes on every write,
 * and every lifecycle request must carry the revision it was rendered from. A
 * second window holding a stale record therefore fails with `deployment-stale`
 * instead of stopping or deleting a sandbox that has since been repointed at a
 * different account.
 */

import { randomUUID } from "crypto";
import Store from "../../utils/privateSettingsStore";

import type {
  SandboxContainerState,
  SandboxDeployment,
  SandboxDeploymentStatus,
  SandboxDeploymentTarget,
} from "../../../shared/cloudflareSandbox";
import { SandboxOperationError } from "./errors";

interface PersistedDeployment {
  deploymentId: string;
  revision: string;
  status: SandboxDeploymentStatus;
  profileName: string;
  accountId: string;
  accountName: string;
  workerName: string;
  deployedAt: string | null;
  errorMessage: string | null;
  container: SandboxContainerState;
}

interface StoreSchema {
  deployment?: PersistedDeployment;
  /**
   * Stable per-installation id. The Worker name is derived from it so two
   * Nimbalyst installations signed into the same Cloudflare account cannot
   * deploy the same Worker and end up sharing one `personal` Durable Object.
   */
  installationId?: string;
}

let store: Store<StoreSchema> | null = null;

// Lazy: electron-store resolves app.getPath('userData') at construction, which
// is not available at module load. See MAIN_PROCESS_INIT.md.
function getStore(): Store<StoreSchema> {
  if (!store) {
    store = new Store<StoreSchema>({ name: "cloudflare-sandbox" });
  }
  return store;
}

/** Test-only. */
export function __setDeploymentStoreForTests(
  next: Store<StoreSchema> | null
): void {
  store = next;
}

/** Create the installation id on first use and never change it after. */
export function getInstallationId(): string {
  const existing = getStore().get("installationId");
  if (typeof existing === "string" && existing) return existing;
  const created = randomUUID();
  getStore().set("installationId", created);
  return created;
}

const NEVER_OBSERVED: SandboxContainerState = {
  status: "unknown",
  observedAt: null,
  message: null,
};

export function readDeployment(): SandboxDeployment | null {
  const saved = getStore().get("deployment");
  return saved ? toContract(saved) : null;
}

export interface CreateDeploymentInput {
  /** Reuse an existing id when re-saving a deployment already in flight. */
  deploymentId?: string;
  profileName: string;
  accountId: string;
  accountName: string;
  workerName: string;
  status: SandboxDeploymentStatus;
  deployedAt: string | null;
  errorMessage?: string | null;
}

/** Replace the saved record wholesale. Used when a deploy completes. */
export function writeDeployment(
  input: CreateDeploymentInput
): SandboxDeployment {
  const existing = getStore().get("deployment");
  const record: PersistedDeployment = {
    // Keep the id stable across redeploys of the same worker in the same
    // account: it identifies the sandbox, not the deploy event.
    deploymentId:
      input.deploymentId ??
      (existing &&
      existing.accountId === input.accountId &&
      existing.workerName === input.workerName
        ? existing.deploymentId
        : randomUUID()),
    revision: randomUUID(),
    status: input.status,
    profileName: input.profileName,
    accountId: input.accountId,
    accountName: input.accountName,
    workerName: input.workerName,
    deployedAt: input.deployedAt,
    errorMessage: input.errorMessage ?? null,
    container: existing?.container ?? NEVER_OBSERVED,
  };
  getStore().set("deployment", record);
  return toContract(record);
}

/** Patch the saved record, bumping the revision. Throws if none exists. */
export function updateDeployment(
  patch: Partial<
    Pick<PersistedDeployment, "status" | "errorMessage" | "container">
  >
): SandboxDeployment {
  const existing = getStore().get("deployment");
  if (!existing) {
    throw new SandboxOperationError(
      "deployment-stale",
      "update-without-record"
    );
  }
  const record: PersistedDeployment = {
    ...existing,
    ...patch,
    revision: randomUUID(),
  };
  getStore().set("deployment", record);
  return toContract(record);
}

/**
 * Patch the record only if its revision is still `expectedRevision`.
 *
 * Returns null when the record changed or vanished while the caller was doing
 * something slow. Used by passive observation: an unconditional write there
 * would stamp an old container reading onto whatever deployment now owns the
 * single saved slot.
 */
export function updateDeploymentIfUnchanged(
  expectedRevision: string,
  patch: Partial<
    Pick<PersistedDeployment, "status" | "errorMessage" | "container">
  >
): SandboxDeployment | null {
  const existing = getStore().get("deployment");
  if (!existing || existing.revision !== expectedRevision) return null;
  return updateDeployment(patch);
}

export function clearDeployment(): void {
  getStore().delete("deployment");
}

/** The Worker name of the saved deployment, needed to address it. */
export function readWorkerName(): string | null {
  return getStore().get("deployment")?.workerName ?? null;
}

/**
 * Assert a lifecycle request matches the saved record on every field, and
 * return that record.
 *
 * Checking all four fields rather than just the revision is deliberate. The
 * revision alone would catch a stale window, but not a request whose account
 * was rewritten in transit; on a destructive path the cheap extra comparisons
 * are worth having.
 */
export function requireTarget(
  target: SandboxDeploymentTarget
): SandboxDeployment {
  const saved = getStore().get("deployment");
  if (!saved) {
    throw new SandboxOperationError(
      "deployment-stale",
      "lifecycle-without-record"
    );
  }
  const mismatch =
    saved.deploymentId !== target.deploymentId ||
    saved.revision !== target.revision ||
    saved.profileName !== target.profileName ||
    saved.accountId !== target.accountId;

  if (mismatch) {
    throw new SandboxOperationError(
      "deployment-stale",
      "lifecycle-target-mismatch"
    );
  }
  return toContract(saved);
}

function toContract(record: PersistedDeployment): SandboxDeployment {
  return {
    deploymentId: record.deploymentId,
    revision: record.revision,
    status: record.status,
    container: record.container,
    profileName: record.profileName,
    account: { id: record.accountId, name: record.accountName },
    // The control path is a private Worker RPC binding, so there is no public
    // URL by design. Null here is the expected value, not a missing one.
    access: "private-rpc",
    url: null,
    deployedAt: record.deployedAt,
    errorMessage: record.errorMessage,
  };
}
