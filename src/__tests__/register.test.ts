// `register(ctx)` shape — the cinatra#172 Stage H4 serverEntry cutover: the
// connector binds its host deps slot itself (always-bind, lazy per-call
// host-service resolution over `@cinatra-ai/host:youtube-connection`).
// Leaf-graph pin: the entry imports ONLY ./deps. Slot-timing coverage
// (cinatra#172 finding 8): the slot is populated AT ACTIVATION — before the
// MCP handlers resolve it — and an unbound slot fails LOUD naming the package
// and the registration step.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { register } from "../register";
import {
  getMediaFeedsDeps,
  registerMediaFeedsConnector,
  _resetMediaFeedsDepsForTests,
} from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
  } as never;
  register(ctx);
  return { resolveProviders };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMediaFeedsDepsForTests();
});

describe("register(ctx) — deps binding (cinatra#172 Stage H4)", () => {
  it("binds the deps slot at activation, resolving the host service LAZILY at call time", async () => {
    const getConfiguredAccessToken = vi.fn(async () => "ya29.token");
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:youtube-connection": { getConfiguredAccessToken },
    });
    // No host-service resolution happened at registration (probe-safe), but
    // the slot IS bound — handler bundles resolving it later succeed.
    expect(resolveProviders).not.toHaveBeenCalled();

    await expect(getMediaFeedsDeps().getConfiguredYouTubeAccessToken()).resolves.toBe(
      "ya29.token",
    );
    expect(getConfiguredAccessToken).toHaveBeenCalledTimes(1);
  });

  it("preserves the host's null / reject semantics through the adapter", async () => {
    activateWithServices({
      "@cinatra-ai/host:youtube-connection": {
        getConfiguredAccessToken: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error("nango credential resolution failed")),
      },
    });
    await expect(getMediaFeedsDeps().getConfiguredYouTubeAccessToken()).resolves.toBeNull();
    await expect(getMediaFeedsDeps().getConfiguredYouTubeAccessToken()).rejects.toThrow(
      /nango credential resolution failed/,
    );
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", async () => {
    const sentinel = vi.fn(async () => "stale-token");
    registerMediaFeedsConnector({ getConfiguredYouTubeAccessToken: sentinel });
    activateWithServices({
      "@cinatra-ai/host:youtube-connection": {
        getConfiguredAccessToken: async () => "fresh-token",
      },
    });
    await expect(getMediaFeedsDeps().getConfiguredYouTubeAccessToken()).resolves.toBe(
      "fresh-token",
    );
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getMediaFeedsDeps().getConfiguredYouTubeAccessToken()).toThrow(
      /host service "@cinatra-ai\/host:youtube-connection" is not registered/,
    );
  });

  it("fails LOUD with the package name + registration step when the SLOT itself is unbound", () => {
    expect(() => getMediaFeedsDeps()).toThrow(
      /@cinatra-ai\/media-feeds-connector: host runtime deps not registered[\s\S]*registerMediaFeedsConnector/,
    );
  });
});
