/**
 * IPC surface for the Cloudflare Sandboxes settings panel.
 *
 * Thin by design: every handler forwards to `CloudflareSandboxService`, which
 * already returns `CloudflareSandboxResponse<T>` and never rejects. The panel
 * therefore always receives a renderable result, and a raw subprocess error can
 * never escape into the renderer.
 */

import { app } from "electron";
import { safeHandle } from "../utils/ipcRegistry";
import { killInFlightHelpers } from "../services/cloudflareSandbox/sandboxControl";
import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  type CreateProfileRequest,
  type DeleteDeploymentRequest,
  type DeployRequest,
  type ListAccountsRequest,
  type PlanDeploymentRequest,
  type StopRequest,
  type WakeRequest,
} from "../../shared/cloudflareSandbox";
import { getCloudflareSandboxService } from "../services/cloudflareSandbox/CloudflareSandboxService";

export function registerCloudflareSandboxHandlers(): void {
  app.on("will-quit", killInFlightHelpers);
  const service = () => getCloudflareSandboxService();

  safeHandle(CLOUDFLARE_SANDBOX_CHANNELS.getPrerequisites, () =>
    service().getPrerequisites()
  );

  safeHandle(CLOUDFLARE_SANDBOX_CHANNELS.listProfiles, () =>
    service().listProfiles()
  );

  safeHandle(
    CLOUDFLARE_SANDBOX_CHANNELS.createProfile,
    (_event, request: CreateProfileRequest) => service().createProfile(request)
  );

  safeHandle(
    CLOUDFLARE_SANDBOX_CHANNELS.listAccounts,
    (_event, request: ListAccountsRequest) => service().listAccounts(request)
  );

  safeHandle(
    CLOUDFLARE_SANDBOX_CHANNELS.planDeployment,
    (_event, request: PlanDeploymentRequest) =>
      service().planDeployment(request)
  );

  safeHandle(
    CLOUDFLARE_SANDBOX_CHANNELS.deploy,
    (_event, request: DeployRequest) => service().deploy(request)
  );

  safeHandle(CLOUDFLARE_SANDBOX_CHANNELS.getDeployment, () =>
    service().getDeployment()
  );

  safeHandle(CLOUDFLARE_SANDBOX_CHANNELS.wake, (_event, request: WakeRequest) =>
    service().wake(request)
  );

  safeHandle(CLOUDFLARE_SANDBOX_CHANNELS.stop, (_event, request: StopRequest) =>
    service().stop(request)
  );

  safeHandle(
    CLOUDFLARE_SANDBOX_CHANNELS.deleteDeployment,
    (_event, request: DeleteDeploymentRequest) =>
      service().deleteDeployment(request)
  );
}
