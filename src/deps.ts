// Host DI singleton for the media-feeds connector's runtime deps.
//
// The connector carries NO non-SDK `@cinatra-ai/*` code dependency and NO `@/`
// host-internal import (cinatra#172 Stage H4): the single host-shared surface
// it needs — the YouTube OAuth access-token mint — is delivered here, bound at
// activation by `register(ctx)` adapting the per-concern host service
// published in the capability registry (`@cinatra-ai/host:youtube-connection`).
//
//   - getConfiguredYouTubeAccessToken — Nango-backed OAuth2 bearer mint over
//     the saved YouTube connection (`@/lib/youtube-api` stays host-side; the
//     credential refresh runs host-side inside the member). The MCP handler
//     passes the MINT FUNCTION into the scraper unchanged; the minted bearer
//     is forwarded only to Google's YouTube Data API and never crosses any
//     other wire boundary (the host service's TRUST note). Null/throw
//     semantics are the host's: null when Nango is unconfigured or the
//     resolved credentials are not a usable OAUTH2 bearer (incl. the legacy
//     fixed-connection-id fallback), REJECTS on a failing credential
//     resolution — callers keep their existing handling.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol
// so the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the MCP handlers do NOT import the
// registrar) — resolve the SAME slot. A plain module-local binding would
// leave those bundles' instance unregistered → getMediaFeedsDeps() would
// throw. (Same reason as the SDK action-guard + the crm/github/wordpress-mcp
// deps slots.)

export interface MediaFeedsConnectorDeps {
  /** Nango-backed OAuth2 access-token mint for the saved YouTube connection
   * (null when unconfigured / not a usable bearer; rejects on a failing
   * credential resolution — the host's exact semantics). */
  getConfiguredYouTubeAccessToken: () => Promise<string | null>;
}

const MEDIA_FEEDS_DEPS_KEY = Symbol.for("@cinatra-ai/media-feeds-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: MediaFeedsConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

export function registerMediaFeedsConnector(deps: MediaFeedsConnectorDeps): void {
  _holder[MEDIA_FEEDS_DEPS_KEY] = deps;
}

export function getMediaFeedsDeps(): MediaFeedsConnectorDeps {
  const deps = _holder[MEDIA_FEEDS_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/media-feeds-connector: host runtime deps not registered. " +
        "Call registerMediaFeedsConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetMediaFeedsDepsForTests(): void {
  _holder[MEDIA_FEEDS_DEPS_KEY] = null;
}
