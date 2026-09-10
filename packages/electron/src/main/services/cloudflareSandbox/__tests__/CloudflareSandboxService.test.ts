// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SandboxDeployment,
  SandboxDeploymentTarget,
} from "../../../../shared/cloudflareSandbox";

// The store reaches electron-store, and profiles/wranglerCli spawn Wrangler.
// Both are mocked so these tests exercise the service's own decisions.
vi.mock("../deploymentStore", () => ({
  readDeployment: vi.fn(),
  readWorkerName: vi.fn(),
  requireTarget: vi.fn(),
  updateDeployment: vi.fn(),
  updateDeploymentIfUnchanged: vi.fn(),
  writeDeployment: vi.fn(),
  clearDeployment: vi.fn(),
  getInstallationId: vi.fn(() => "install-1"),
}));
vi.mock("../profiles", () => ({
  listAccounts: vi.fn(),
  listProfiles: vi.fn(),
  createOrReauthenticateProfile: vi.fn(),
  resolvedProfileDir: vi.fn(async () => "/tmp/profiles/work"),
}));
vi.mock("../workerConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workerConfig")>()),
  writeControlConfig: vi.fn(async () => "/tmp/control/wrangler.json"),
}));
vi.mock("../wranglerCli", () => ({
  runWrangler: vi.fn(),
  resolveWranglerModulePath: vi.fn(async () => "/tmp/wrangler/cli.js"),
}));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { CloudflareSandboxService } from "../CloudflareSandboxService";
import type { SandboxArtifactProvider } from "../artifactProvider";
import * as store from "../deploymentStore";
import * as profiles from "../profiles";
import { runWrangler } from "../wranglerCli";
import { SandboxOperationError } from "../errors";
import { deriveWorkerName, writeControlConfig } from "../workerConfig";

const WORKER_NAME = deriveWorkerName("install-1");

const ACCOUNT = { id: "acct-1", name: "Work Account" };

const SAVED: SandboxDeployment = {
  deploymentId: "dep-1",
  revision: "rev-1",
  status: "deployed",
  container: { status: "stopped", observedAt: null, message: null },
  profileName: "work",
  account: ACCOUNT,
  access: "private-rpc",
  url: null,
  deployedAt: "2026-09-09T00:00:00.000Z",
  errorMessage: null,
};

const TARGET: SandboxDeploymentTarget = {
  deploymentId: "dep-1",
  revision: "rev-1",
  profileName: "work",
  accountId: "acct-1",
};

function availableArtifacts(): SandboxArtifactProvider {
  return {
    describe: vi.fn(async () => ({
      available: true as const,
      workerName: "",
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-a",
    })),
    helper: vi.fn(async () => ({ helperPath: "/tmp/artifact/rpc-helper.mjs" })),
    prepare: vi.fn(async () => ({
      projectDir: "/tmp/artifact",
      configPath: "/tmp/artifact/wrangler.jsonc",
      workerName: WORKER_NAME,
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "a".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-a",
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(profiles.listAccounts).mockResolvedValue([ACCOUNT]);
  vi.mocked(store.readDeployment).mockReturnValue(null);
  vi.mocked(store.readWorkerName).mockReturnValue(WORKER_NAME);
  vi.mocked(store.requireTarget).mockReturnValue(SAVED);
  vi.mocked(store.updateDeploymentIfUnchanged).mockImplementation(
    (_revision, patch) =>
      ({ ...SAVED, ...patch, revision: "rev-2" } as SandboxDeployment)
  );
  vi.mocked(store.updateDeployment).mockImplementation(
    (patch) => ({ ...SAVED, ...patch, revision: "rev-2" } as SandboxDeployment)
  );
  vi.mocked(store.writeDeployment).mockImplementation(
    (input) =>
      ({
        ...SAVED,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      } as SandboxDeployment)
  );
  answerWrangler({ applications: [] });
});

const APP_ID = "a033a6ac-f267-4792-baac-09437eb1f1fd";
const OTHER_APP_ID = "5e0d7e0b-2f8e-4a5e-9f1a-3c1e0d3b8a11";

/**
 * Wrangler answers by command. `containers list` reports `applications` on the
 * first call and `remaining` afterwards, so a test can model an application
 * that survives its own delete.
 */
function answerWrangler(options: {
  applications: Array<{ id: string; name: string }>;
  remaining?: Array<{ id: string; name: string }>;
  workerDelete?: () => Promise<void>;
}) {
  let lists = 0;
  vi.mocked(runWrangler).mockImplementation(async (args) => {
    if (args[0] === "delete" && options.workerDelete) await options.workerDelete();
    if (args[0] === "containers" && args[1] === "list") {
      lists += 1;
      const apps =
        lists === 1 ? options.applications : options.remaining ?? [];
      return { stdout: JSON.stringify(apps), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("planDeployment", () => {
  it("refuses an account the chosen profile cannot reach", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });

    const result = await service.planDeployment({
      profileName: "work",
      accountId: "someone-elses-account",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "account-required" },
    });
  });

  it("reports the artifact as unavailable instead of offering a plan that cannot deploy", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(
      /does not include the Cloudflare sandbox Worker/i
    );
  });

  it("never spawns Wrangler for a deploy when no plan was approved", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });

    const result = await service.deploy({
      planId: "fabricated",
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });
});

describe("deploy", () => {
  it("passes the explicit profile to Wrangler rather than relying on a default", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");

    await service.deploy({
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    });

    const [args] = vi.mocked(runWrangler).mock.calls[0] as [string[]];
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("work");
  });

  it("records an error against the attempted account when Wrangler fails", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    vi.mocked(runWrangler).mockRejectedValueOnce(
      new SandboxOperationError("deploy-failed", "boom")
    );

    const result = await service.deploy({
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "deploy-failed" },
    });
    expect(vi.mocked(store.writeDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", accountId: "acct-1" })
    );
  });

  it("will not accept the same approved plan twice", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    const request = {
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    };

    expect((await service.deploy(request)).success).toBe(true);
    expect(await service.deploy(request)).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
  });
});

describe("lifecycle target binding", () => {
  it("refuses a stale target rather than acting on the saved sandbox", async () => {
    vi.mocked(store.requireTarget).mockImplementation(() => {
      throw new SandboxOperationError("deployment-stale", "revision mismatch");
    });
    const service = new CloudflareSandboxService();

    const result = await service.stop({
      ...TARGET,
      revision: "stale",
      discardEphemeralData: true,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "deployment-stale" },
    });
  });

  it("asks the worker to discard ephemeral data on stop, explicitly", async () => {
    const stop = vi.fn(async () => ({
      sandboxId: "personal" as const,
      state: "stopped" as const,
      lastChangedAt: 0,
      sleepAfterSeconds: 300,
      persistence: "ephemeral" as const,
    }));
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: { status: vi.fn(), wake: vi.fn(), stop } as never,
    });

    await service.stop({ ...TARGET, discardEphemeralData: true });

    expect(stop).toHaveBeenCalledWith(expect.anything(), {
      discardEphemeralData: true,
    });
  });

  it("records an unreachable container as an observation, not a deployment error", async () => {
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(),
        wake: vi.fn(async () => {
          throw new SandboxOperationError(
            "container-unavailable",
            "helper-timeout"
          );
        }),
        stop: vi.fn(),
      } as never,
    });

    const result = await service.wake(TARGET);

    expect(result).toMatchObject({
      success: false,
      error: { code: "container-unavailable" },
    });
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({
        container: expect.objectContaining({ status: "unknown" }),
      })
    );
    expect(vi.mocked(store.updateDeployment)).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });
});

describe("deleteDeployment", () => {
  it("refuses without the explicit confirmation flag and never calls Wrangler", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: false as unknown as true,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: "confirmation-required" },
    });
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });

  it("keeps the saved record when the delete fails, so a live worker is not orphaned", async () => {
    vi.mocked(runWrangler).mockRejectedValueOnce(new Error("network down"));
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result.success).toBe(false);
    expect(vi.mocked(store.clearDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("clears the record only after Wrangler reports the worker deleted", async () => {
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });

  // Wrangler's Worker delete leaves the container application behind, which
  // the first live delete proved: the panel said nothing remained while the
  // application sat in the account in state "ready".
  it("deletes every container application named for the worker, and only those, before clearing the record", async () => {
    answerWrangler({
      applications: [
        { id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` },
        { id: OTHER_APP_ID, name: "someone-elses-worker-nimbalystsandbox" },
      ],
      remaining: [
        { id: OTHER_APP_ID, name: "someone-elses-worker-nimbalystsandbox" },
      ],
    });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    const commands = vi
      .mocked(runWrangler)
      .mock.calls.map(([args]) => args.slice(0, 3).join(" "));
    expect(commands).toContain(`containers delete ${APP_ID}`);
    expect(commands.join("\n")).not.toContain(OTHER_APP_ID);
    // The Worker goes first: its Durable Object is what keeps the container alive.
    expect(commands.indexOf(`delete --name ${WORKER_NAME}`)).toBeLessThan(
      commands.indexOf(`containers delete ${APP_ID}`)
    );
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });

  it("keeps the record when a container application survives the delete", async () => {
    const app = { id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` };
    answerWrangler({ applications: [app], remaining: [app] });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result.success).toBe(false);
    expect(vi.mocked(store.clearDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateDeployment)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("still removes the container application when an earlier attempt already deleted the worker", async () => {
    answerWrangler({
      applications: [{ id: APP_ID, name: `${WORKER_NAME}-nimbalystsandbox` }],
      workerDelete: async () => {
        throw new SandboxOperationError("worker-missing", "wrangler-cli");
      },
    });
    const service = new CloudflareSandboxService();

    const result = await service.deleteDeployment({
      ...TARGET,
      confirmed: true,
    });

    expect(result).toEqual({ success: true, data: null });
    expect(
      vi.mocked(runWrangler).mock.calls.some(
        ([args]) => args[0] === "containers" && args[1] === "delete" && args[2] === APP_ID
      )
    ).toBe(true);
    expect(vi.mocked(store.clearDeployment)).toHaveBeenCalledOnce();
  });
});

describe("review regressions", () => {
  /** Approve a plan and return the deploy request for it. */
  async function approved(service: CloudflareSandboxService) {
    const planned = await service.planDeployment({
      profileName: "work",
      accountId: "acct-1",
    });
    if (!planned.success) throw new Error("expected a plan");
    return {
      planId: planned.data.planId,
      profileName: "work",
      accountId: "acct-1",
    };
  }

  it("B2: refuses when prepare returns a different artifact than was reviewed", async () => {
    const artifacts = availableArtifacts();
    const service = new CloudflareSandboxService({ artifacts });
    const request = await approved(service);

    // The artifact directory is rebuilt between describe() and prepare().
    vi.mocked(artifacts.prepare).mockResolvedValueOnce({
      projectDir: "/tmp/artifact",
      configPath: "/tmp/artifact/wrangler.json",
      workerName: WORKER_NAME,
      imageRef: "docker.io/nimbalyst/sandbox@sha256:" + "b".repeat(64),
      container: {
        instanceType: "standard-3",
        maxInstances: 1,
        sleepAfterMinutes: 5,
      },
      contentHash: "hash-b",
    });

    const result = await service.deploy(request);

    expect(result).toMatchObject({
      success: false,
      error: { code: "plan-stale" },
    });
    // Nothing was saved and nothing was sent: the check runs before both.
    expect(vi.mocked(store.writeDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });

  it.each(["error", "deploying", "deleting"] as const)(
    "B3: a saved %s record for another account blocks a deploy that would orphan it",
    async (status) => {
      vi.mocked(store.readDeployment).mockReturnValue({
        ...SAVED,
        status,
        account: { id: "other-account", name: "Other" },
      });
      const service = new CloudflareSandboxService({
        artifacts: availableArtifacts(),
      });
      const request = await approved(service);

      const result = await service.deploy(request);

      expect(result).toMatchObject({
        success: false,
        error: { code: "deployment-stale" },
      });
      expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
    }
  );

  it("B4: a slow status observation does not overwrite a record that changed meanwhile", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    vi.mocked(store.updateDeploymentIfUnchanged).mockReturnValue(null);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(async () => ({
          sandboxId: "personal" as const,
          state: "running" as const,
          lastChangedAt: 0,
          sleepAfterSeconds: 300,
          persistence: "ephemeral" as const,
        })),
        wake: vi.fn(),
        stop: vi.fn(),
      } as never,
    });

    await service.getDeployment();

    // Conditional on the revision it observed, never unconditional.
    expect(vi.mocked(store.updateDeploymentIfUnchanged)).toHaveBeenCalledWith(
      "rev-1",
      expect.objectContaining({ container: expect.anything() })
    );
    expect(vi.mocked(store.updateDeployment)).not.toHaveBeenCalled();
  });

  it("B4: refresh actually observes the container instead of returning the cache", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const status = vi.fn(async () => ({
      sandboxId: "personal" as const,
      state: "running" as const,
      lastChangedAt: 0,
      sleepAfterSeconds: 300,
      persistence: "ephemeral" as const,
    }));
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: { status, wake: vi.fn(), stop: vi.fn() } as never,
    });

    await service.getDeployment();

    expect(status).toHaveBeenCalledOnce();
  });

  it("B4: an unreachable container leaves the deployment status alone", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
      control: {
        status: vi.fn(async () => {
          throw new SandboxOperationError(
            "container-unavailable",
            "helper:rpc-failed"
          );
        }),
        wake: vi.fn(),
        stop: vi.fn(),
      } as never,
    });

    const result = await service.getDeployment();

    expect(result.success).toBe(true);
    const patch = vi.mocked(store.updateDeploymentIfUnchanged).mock
      .calls[0]?.[1];
    expect(patch).not.toHaveProperty("status");
    expect(patch?.container).toMatchObject({ status: "unknown" });
  });

  it("serialises mutations so a queued deploy cannot interleave with a delete", async () => {
    const order: string[] = [];
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) => {
      order.push(`${args[0]}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${args[0]}:end`);
      return { stdout: args[0] === "containers" ? "[]" : "", stderr: "" };
    });
    const service = new CloudflareSandboxService({
      artifacts: availableArtifacts(),
    });
    const request = await approved(service);

    await Promise.allSettled([
      service.deploy(request),
      service.deleteDeployment({ ...TARGET, confirmed: true }),
    ]);

    // The deploy's single Wrangler call finishes before any of the delete's
    // calls (worker delete, application list) begin.
    expect(order.slice(0, 2)).toEqual(["deploy:start", "deploy:end"]);
    expect(order.slice(2).some((event) => event.startsWith("deploy"))).toBe(false);
    // No operation starts before the previous one finished.
    for (let i = 0; i + 1 < order.length; i += 2) {
      expect(order[i].endsWith(":start")).toBe(true);
      expect(order[i + 1]).toBe(order[i].replace(":start", ":end"));
    }
  });

  it("deletes the saved Worker explicitly while retaining the account config", async () => {
    vi.mocked(store.readDeployment).mockReturnValue(SAVED);
    const service = new CloudflareSandboxService();

    await service.deleteDeployment({ ...TARGET, confirmed: true });

    const [args] = vi.mocked(runWrangler).mock.calls[0] as [string[]];
    expect(args).toContain("--config");
    expect(args[args.indexOf("--name") + 1]).toBe(WORKER_NAME);
    expect(writeControlConfig).toHaveBeenCalledWith({workerName:WORKER_NAME,accountId:SAVED.account.id});
    expect(args[args.indexOf("--profile") + 1]).toBe(SAVED.profileName);
    expect(vi.mocked(runWrangler).mock.calls[0][1]).toMatchObject({cwd:"/tmp/profiles/work"});
  });
});
