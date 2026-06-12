// The media-feeds connector's `register(ctx)` server entry.
//
// hostInternal pinned-empty sweep (cinatra#172 Stage H4): the MCP handlers
// stop importing `@/lib/youtube-api` — this entry binds the connector's host
// deps AT ACTIVATION by adapting the per-concern host service published in
// the capability registry (`@cinatra-ai/host:youtube-connection`). The
// adapter member resolves its host service LAZILY at call time, so activation
// order against the host's boot imports never matters.
//
// Registration-only (no I/O) — safe under required-extension-activation's
// prod-boot arming, and probe-safe (the hot-update probe's `resolveProviders`
// reads stay live, so a probe-bound deps slot resolves identically to an
// activation-bound one). Imports stay LEAF-only (`./deps`): the package index
// re-exports the scraper graph, which must stay OUT of the serverEntry graph.
//
// SDK imports here are TYPE-ONLY (host-peer value-import ban): the host
// service arrives as DATA through `ctx.capabilities`; the capability id is an
// inlined string literal; the service shape is a local structural type so the
// connector compiles against ANY host SDK it can meet during skew.

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { registerMediaFeedsConnector, type MediaFeedsConnectorDeps } from "./deps";

const PACKAGE_NAME = "@cinatra-ai/media-feeds-connector";

// Local STRUCTURAL shape of the per-concern host service this connector
// adapts into its deps slot.
type HostYouTubeConnectionShape = {
  getConfiguredAccessToken: MediaFeedsConnectorDeps["getConfiguredYouTubeAccessToken"];
};

/** Lazy per-concern host-service resolution (fail-loud on a missing service —
 * the host boot wiring publishes it before any connector call runs). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** Build the host-bound deps from the per-concern host service. The member
 * resolves LAZILY at call time — constructing this object does no I/O and no
 * resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): MediaFeedsConnectorDeps {
  const youtube = () =>
    hostService<HostYouTubeConnectionShape>(ctx, "@cinatra-ai/host:youtube-connection");
  return {
    getConfiguredYouTubeAccessToken: () => youtube().getConfiguredAccessToken(),
  };
}

export function register(ctx: ExtensionHostContext): void {
  // Bind the host deps slot. Always-bind: re-activation — incl. a hot-update
  // digest swap — re-binds fresh lazy resolvers, so a stale deps object can
  // never outlive its digest.
  registerMediaFeedsConnector(buildHostBoundDeps(ctx));
}
