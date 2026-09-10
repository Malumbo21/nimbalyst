/**
 * Orchestrates the Cloudflare sandbox settings flow.
 *
 * Every method returns `CloudflareSandboxResponse<T>` and never rejects, so the
 * settings panel always has something to render.
 *
 * Three invariants are enforced here rather than at the call sites:
 *
 *   1. **One mutation at a time.** Deploy, wake, stop and delete run through a
 *      serial queue. Without it, a deploy to account B could finish after a
 *      delete of account A and write its result over the newer record — the
 *      saved deployment is a single slot, and interleaved writes silently
 *      repoint it at the wrong account.
 *   2. **Revalidate at execution, not at enqueue.** A request that waited behind
 *      another mutation re-checks its target against the saved record before it
 *      acts, because the record it was rendered from may no longer be current.
 *   3. **Save before the remote call, not after.** `wrangler deploy` is not
 *      transactional: it uploads the Worker before provisioning the container.
 *      If the app dies mid-deploy, the identity needed to find and delete that
 *      half-built Worker has to already be on disk.
 */

import type {
  CloudflareAccount,
  CloudflareSandboxPrerequisites,
  CloudflareSandboxResponse,
  CreateProfileRequest,
  DeleteDeploymentRequest,
  DeployRequest,
  DeploymentPlan,
  ListAccountsRequest,
  PlanDeploymentRequest,
  SandboxDeployment,
  SandboxDeploymentTarget,
  StopRequest,
  WakeRequest,
  WranglerProfile,
} from "../../../shared/cloudflareSandbox";
import {
  PackagedArtifactProvider,
  type SandboxArtifactProvider,
} from "./artifactProvider";
import {
  applicationsForWorker,
  deleteContainerApplication,
  listContainerApplications,
} from "./containerApplications";
import {
  buildPlan,
  PlanRegistry,
  requireAvailableArtifact,
  type PlanInputs,
} from "./deploymentPlan";
import {
  clearDeployment,
  getInstallationId,
  readDeployment,
  readWorkerName,
  requireTarget,
  updateDeployment,
  updateDeploymentIfUnchanged,
  writeDeployment,
} from "./deploymentStore";
import { SandboxOperationError, toSandboxError } from "./errors";
import { getPrerequisites } from "./prerequisites";
import {
  createOrReauthenticateProfile,
  listAccounts,
  listProfiles,
  resolvedProfileDir,
} from "./profiles";
import {
  ChildProcessControlClient,
  type SandboxControlClient,
  type SandboxControlTarget,
  toContainerState,
  unreachableContainerState,
} from "./sandboxControl";
import { resolveWranglerModulePath, runWrangler } from "./wranglerCli";
import { deriveWorkerName, writeControlConfig } from "./workerConfig";
import { isValidProfileName } from "./wranglerPaths";

export interface CloudflareSandboxServiceDeps {
  artifacts?: SandboxArtifactProvider;
  control?: SandboxControlClient;
  now?: () => Date;
}

export class CloudflareSandboxService {
  #artifacts: SandboxArtifactProvider;
  #control: SandboxControlClient;
  #now: () => Date;
  #plans = new PlanRegistry();
  /** Serialises every mutating operation. See invariant 1. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: CloudflareSandboxServiceDeps = {}) {
    this.#artifacts = deps.artifacts ?? new PackagedArtifactProvider();
    this.#control = deps.control ?? new ChildProcessControlClient();
    this.#now = deps.now ?? (() => new Date());
  }

  async getPrerequisites(): Promise<
    CloudflareSandboxResponse<CloudflareSandboxPrerequisites>
  > {
    return this.#guard(() => getPrerequisites());
  }

  async listProfiles(): Promise<CloudflareSandboxResponse<WranglerProfile[]>> {
    return this.#guard(() => listProfiles());
  }

  async createProfile(
    request: CreateProfileRequest
  ): Promise<CloudflareSandboxResponse<WranglerProfile>> {
    return this.#guard(async () => {
      if (!isValidProfileName(request?.name)) {
        throw new SandboxOperationError("unknown", "create-profile-bad-name");
      }
      return createOrReauthenticateProfile(
        request.name,
        request.reauthenticate === true
      );
    });
  }

  async listAccounts(
    request: ListAccountsRequest
  ): Promise<CloudflareSandboxResponse<CloudflareAccount[]>> {
    return this.#guard(async () => {
      if (!isValidProfileName(request?.profileName)) {
        throw new SandboxOperationError("unknown", "list-accounts-bad-profile");
      }
      return listAccounts(request.profileName);
    });
  }

  async planDeployment(
    request: PlanDeploymentRequest
  ): Promise<CloudflareSandboxResponse<DeploymentPlan>> {
    return this.#guard(async () => {
      const { profileName, accountId } =
        this.#requireProfileAndAccount(request);
      return this.#plans.remember(
        buildPlan(await this.#planInputs(profileName, accountId))
      );
    });
  }

  async deploy(
    request: DeployRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const { profileName, accountId } =
          this.#requireProfileAndAccount(request);
        if (typeof request.planId !== "string" || !request.planId) {
          throw new SandboxOperationError(
            "plan-stale",
            "deploy-without-plan-id"
          );
        }

        // Recomputed here, after any queued mutation has finished, so a plan
        // approved before an intervening delete cannot be replayed.
        const inputs = await this.#planInputs(profileName, accountId);
        this.#plans.requireCurrent(
          request.planId,
          { profileName, accountId },
          inputs
        );

        const existing = readDeployment();
        if (existing && existing.account.id !== accountId) {
          // Any saved record for another account blocks, whatever its status.
          // `error`, `deploying` and `deleting` are exactly the states that can
          // be holding half-created, billable resources, and there is one saved
          // slot: overwriting it loses the only pointer to them. Clearing that
          // record is the user's decision, made through delete.
          throw new SandboxOperationError(
            "deployment-stale",
            "deploy-would-orphan-existing",
            "A sandbox for a different Cloudflare account is already recorded, and it may still have resources in that account. Delete it first so nothing is left behind."
          );
        }

        const artifact = await this.#artifacts.prepare({
          accountId,
          accountName: inputs.account.name,
          profileName,
          workerName: inputs.workerName,
        });

        // `describe()` and `prepare()` read the artifact directory at different
        // moments. If it was swapped in between, what is about to be deployed is
        // not what the user approved, so compare before anything is written or
        // sent. This runs before the saved record and before Wrangler.
        if (
          artifact.contentHash !== inputs.contentHash ||
          artifact.imageRef !== inputs.imageRef ||
          artifact.workerName !== inputs.workerName ||
          artifact.container.instanceType !== inputs.container.instanceType ||
          artifact.container.maxInstances !== inputs.container.maxInstances ||
          artifact.container.sleepAfterMinutes !==
            inputs.container.sleepAfterMinutes
        ) {
          throw new SandboxOperationError(
            "plan-stale",
            "artifact-changed-after-review",
            "The sandbox files changed while this deployment was being prepared, so nothing was deployed. Review the plan again."
          );
        }

        // Invariant 3: the identity lands on disk before the Worker exists.
        const inFlight = writeDeployment({
          profileName,
          accountId,
          accountName: inputs.account.name,
          workerName: artifact.workerName,
          status: "deploying",
          deployedAt: null,
        });

        try {
          await runWrangler(
            [
              "deploy",
              "--config",
              artifact.configPath,
              "--profile",
              profileName,
            ],
            { cwd: artifact.projectDir, timeoutMs: 10 * 60_000 }
          );
        } catch (error) {
          writeDeployment({
            deploymentId: inFlight.deploymentId,
            profileName,
            accountId,
            accountName: inputs.account.name,
            workerName: artifact.workerName,
            status: "error",
            deployedAt: null,
            errorMessage:
              error instanceof SandboxOperationError
                ? error.message
                : "Wrangler could not finish the deployment.",
          });
          throw error;
        }

        this.#plans.forget(request.planId);
        return writeDeployment({
          deploymentId: inFlight.deploymentId,
          profileName,
          accountId,
          accountName: inputs.account.name,
          workerName: artifact.workerName,
          status: "deployed",
          deployedAt: this.#now().toISOString(),
        });
      })
    );
  }

  /**
   * The saved record plus a fresh container observation.
   *
   * Reading the cache alone would make the panel's Refresh button a no-op. A
   * failed observation is recorded as an unknown container state and the
   * deployment status is left exactly as it was, because an unreachable
   * container says nothing about whether the Worker deployed.
   */
  async getDeployment(): Promise<
    CloudflareSandboxResponse<SandboxDeployment | null>
  > {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = readDeployment();
        if (!saved || saved.status !== "deployed") return saved;

        let container;
        try {
          const target = await this.#controlTarget(saved);
          container = toContainerState(
            await this.#control.status(target),
            this.#now
          );
        } catch (error) {
          container = unreachableContainerState(safeMessage(error), this.#now);
        }

        // The observation took time. Write it only if the record is still the
        // one we observed: a delete or a redeploy that landed meanwhile owns
        // the slot now, and stamping a stale container state onto it would
        // describe a container belonging to a different deployment.
        return (
          updateDeploymentIfUnchanged(saved.revision, { container }) ??
          readDeployment()
        );
      })
    );
  }

  async wake(
    request: WakeRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = requireTarget(request);
        const target = await this.#controlTarget(saved);
        return this.#observe(() => this.#control.wake(target));
      })
    );
  }

  async stop(
    request: StopRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        // Consent is carried explicitly from the renderer's two-step confirm and
        // passed through to the Worker, rather than re-inferred here.
        if (request?.discardEphemeralData !== true) {
          throw new SandboxOperationError(
            "confirmation-required",
            "stop-without-consent"
          );
        }
        const saved = requireTarget(request);
        const target = await this.#controlTarget(saved);
        return this.#observe(() =>
          this.#control.stop(target, { discardEphemeralData: true })
        );
      })
    );
  }

  async deleteDeployment(
    request: DeleteDeploymentRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment | null>> {
    return this.#guard(() =>
      this.#serial(async () => {
        if (request?.confirmed !== true) {
          throw new SandboxOperationError(
            "confirmation-required",
            "delete-without-confirmation"
          );
        }
        const saved = requireTarget(request);

        // See deleteWorker for why the generated config carries the account.
        const configPath = await writeControlConfig({
          workerName: this.#workerName(saved),
          accountId: saved.account.id,
        });
        const cwd = await resolvedProfileDir(saved.profileName);

        const workerName = this.#workerName(saved);
        const scope = { configPath, profileName: saved.profileName, cwd };

        updateDeployment({ status: "deleting" });
        try {
          await deleteWorker(workerName, scope);
          // The Worker delete leaves the container application behind. Remove
          // every application named for this Worker, then look again: the
          // record is cleared only once the account shows none, because the
          // record is the only pointer the UI has to what is still billing.
          for (const app of applicationsForWorker(
            await listContainerApplications(scope),
            workerName
          )) {
            await deleteContainerApplication(app.id, scope);
          }
          const remaining = applicationsForWorker(
            await listContainerApplications(scope),
            workerName
          );
          if (remaining.length > 0) {
            throw new SandboxOperationError(
              "unknown",
              "container-application-remains"
            );
          }
        } catch (error) {
          // Keep the record. A failed delete that erased its own record would
          // strand a live Worker or container with nothing in the UI pointing
          // at it.
          updateDeployment({
            status: "error",
            errorMessage:
              "Nimbalyst could not confirm deletion. This sandbox may still exist in your Cloudflare account.",
          });
          throw error;
        }

        clearDeployment();
        return null;
      })
    );
  }

  // -- internals ----------------------------------------------------------

  /** Run `operation` after every previously queued mutation has settled. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    // Swallow rejection on the chain itself so one failure does not poison
    // every later operation; the caller still sees the real rejection.
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #observe(
    call: () => Promise<Awaited<ReturnType<SandboxControlClient["status"]>>>
  ): Promise<SandboxDeployment> {
    try {
      return updateDeployment({
        container: toContainerState(await call(), this.#now),
      });
    } catch (error) {
      updateDeployment({
        container: unreachableContainerState(safeMessage(error), this.#now),
      });
      throw error;
    }
  }

  async #controlTarget(
    saved: SandboxDeployment
  ): Promise<SandboxControlTarget> {
    const workerName = this.#workerName(saved);
    const [cwd, configPath, helper, wranglerModulePath] = await Promise.all([
      resolvedProfileDir(saved.profileName),
      writeControlConfig({ workerName, accountId: saved.account.id }),
      this.#artifacts.helper(),
      resolveWranglerModulePath(),
    ]);
    return {
      cwd,
      configPath,
      helperPath: helper.helperPath,
      wranglerModulePath,
    };
  }

  /**
   * The persisted Worker name, not a freshly derived one. A record written by
   * an earlier install could carry a different name, and addressing the wrong
   * name on a delete would leave the real Worker running.
   */
  #workerName(saved: SandboxDeployment): string {
    const name = readWorkerName();
    if (!name) {
      throw new SandboxOperationError(
        "deployment-stale",
        "worker-name-missing"
      );
    }
    void saved;
    return name;
  }

  async #planInputs(
    profileName: string,
    accountId: string
  ): Promise<PlanInputs> {
    const accounts = await listAccounts(profileName);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw new SandboxOperationError(
        "account-required",
        "account-not-reachable"
      );
    }

    const artifact = requireAvailableArtifact(await this.#artifacts.describe());
    const saved = readDeployment();
    const workerName = deriveWorkerName(getInstallationId());

    return {
      profileName,
      account,
      workerName,
      imageRef: artifact.imageRef,
      container: artifact.container,
      contentHash: artifact.contentHash,
      workerExists:
        saved?.account.id === accountId && saved.status === "deployed",
    };
  }

  #requireProfileAndAccount(request: {
    profileName?: unknown;
    accountId?: unknown;
  }): { profileName: string; accountId: string } {
    if (!isValidProfileName(request?.profileName)) {
      throw new SandboxOperationError("unknown", "request-bad-profile");
    }
    if (typeof request.accountId !== "string" || !request.accountId) {
      throw new SandboxOperationError("account-required", "request-no-account");
    }
    return { profileName: request.profileName, accountId: request.accountId };
  }

  async #guard<T>(
    operation: () => Promise<T> | T
  ): Promise<CloudflareSandboxResponse<T>> {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, error: toSandboxError(error) };
    }
  }
}

/**
 * Delete the Worker through a generated config carrying the saved account, not
 * a bare `--name`: that would let Wrangler pick an account implicitly and
 * delete a same-named Worker somewhere the user never chose.
 *
 * A Worker that is already gone counts as deleted. That is the retry case: an
 * earlier attempt removed the Worker and then failed on the container
 * application, and the user is trying again to finish the job.
 */
async function deleteWorker(
  workerName: string,
  scope: { configPath: string; profileName: string; cwd: string }
): Promise<void> {
  try {
    await runWrangler(
      [
        "delete",
        "--name",
        workerName,
        "--config",
        scope.configPath,
        "--profile",
        scope.profileName,
        "--force",
      ],
      { cwd: scope.cwd, timeoutMs: 5 * 60_000 }
    );
  } catch (error) {
    if (
      error instanceof SandboxOperationError &&
      error.sandboxErrorCode === "worker-missing"
    ) {
      return;
    }
    throw error;
  }
}

/** Only curated text; never an exception message, which can carry a token. */
function safeMessage(error: unknown): string {
  return error instanceof SandboxOperationError
    ? error.message
    : "The sandbox container could not be reached.";
}

let singleton: CloudflareSandboxService | null = null;

export function getCloudflareSandboxService(): CloudflareSandboxService {
  if (!singleton) singleton = new CloudflareSandboxService();
  return singleton;
}

/** Test-only. */
export function __setCloudflareSandboxService(
  next: CloudflareSandboxService | null
): void {
  singleton = next;
}
