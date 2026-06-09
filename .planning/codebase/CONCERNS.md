# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**Monorepo-rooted vitest config:**
- Issue: `vitest.config.ts` resolves `server-only` and the `@/` path alias by walking three levels up (`../../..`) to a monorepo root that does not exist in this extracted standalone repo. Tests cannot run at all outside the parent monorepo without manual stub setup.
- Files: `vitest.config.ts`
- Impact: CI skips tests entirely when `@cinatra-ai/sdk-extensions` peer is present (which it is), hiding this breakage. Any attempt to run tests standalone fails with a missing module error.
- Fix approach: Either bundle a local `tests/__stubs__/server-only.ts` and a self-contained `@/` alias resolver inside this repo, or document clearly that tests only run inside the monorepo workspace.

**`handlers.ts` hardcodes a monorepo-internal import:**
- Issue: `src/mcp/handlers.ts` imports `@/lib/youtube-api` — an alias that resolves to the monorepo's `src/` directory. This import path is not resolvable in any standalone context and is hidden from CI by the first-party peer skip.
- Files: `src/mcp/handlers.ts`
- Impact: The exported `createMediaFeedsPrimitiveHandlers` function is unusable outside the monorepo without the ambient `@/lib/youtube-api` module providing `getConfiguredYouTubeAccessToken`.
- Fix approach: Accept the token provider as a parameter (mirroring `scrapeYouTubeChannelEpisodes`) rather than importing it directly, making `handlers.ts` self-contained.

**`package.json` points `main`/`types` to source `.ts` files:**
- Issue: `"main": "./src/index.ts"` and `"types": "./src/index.ts"` are not valid CommonJS/ESM entry points for a published package. They work only when consumed by a bundler that accepts TypeScript directly (e.g., the monorepo's Next.js/Turbopack setup).
- Files: `package.json`
- Impact: `npm pack --dry-run` (run in CI) passes, but the published tarball contains `.ts` source that cannot be used by non-bundler consumers. The `outDir: "dist"` in `tsconfig.json` is configured but no build script exists.
- Fix approach: Add a `build` script (`tsc -p tsconfig.json`), set `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, and add `"files": ["dist"]` to `package.json`.

**No build script:**
- Issue: `tsconfig.json` sets `"outDir": "dist"` and `"noEmit": false`, but `package.json` has no `build` or `compile` script.
- Files: `package.json`, `tsconfig.json`
- Impact: The compiled `dist/` directory is never produced, making the `main`/`types` mismatch above unresolvable without monorepo tooling.
- Fix approach: Add `"build": "tsc -p tsconfig.json"` to `package.json` scripts.

**`/c/<slug>` YouTube URL falls back to `forUsername` lookup (acknowledged limitation):**
- Issue: Legacy `/c/<slug>` custom URL form is mapped to `forUsername` mode which may not resolve for many modern accounts. A comment in the code notes the API doesn't accept this form directly.
- Files: `src/youtube.ts` (lines 116–128)
- Impact: Users providing `/c/<slug>` YouTube URLs may receive a `MEDIA_FEED_YOUTUBE_NO_CHANNEL` error even for valid channels.
- Fix approach: Consider a fallback to `search` endpoint with `type=channel` or document the limitation explicitly in the MCP tool description in `src/mcp/registry.ts`.

## Known Bugs

**Hash collision risk in episode ID generation:**
- Symptoms: Two different episodes with different content could produce the same ID if the djb2-style 32-bit integer hash collides.
- Files: `src/youtube.ts` (lines 75–86), `src/feed.ts` (lines 117–128)
- Trigger: Unlikely in practice but possible with large episode sets. The hash is a signed 32-bit integer truncated to base-36, giving ~4 billion buckets — acceptable for small feeds but not guaranteed collision-free.
- Workaround: None currently. Downstream deduplication relies on this ID being stable and unique.

**`matchesDateRange` returns `true` for episodes without a `publishedAt` date:**
- Symptoms: Episodes with no publish date pass date-range filters regardless of `dateFrom`/`dateTo` values, potentially polluting date-filtered results with undated episodes.
- Files: `src/feed.ts` (line 341)
- Trigger: Any podcast with episodes missing `<pubDate>` or `<published>` when called with `filterMode: "date_range"`.
- Workaround: None; callers have no way to exclude undated episodes.

**`looksLikeFeed` regex is very permissive:**
- Symptoms: Any HTML or XML file containing the substring `<rss`, `<feed`, or `<channel` (in any tag context) is treated as a valid feed and skips further discovery.
- Files: `src/feed.ts` (line 139)
- Trigger: A podcast website whose HTML happens to include `<channel` in a script block or inline SVG would be incorrectly short-circuited as a feed URL, returning malformed XML to the cheerio parser.
- Workaround: The cheerio parse would likely fail or return no `<item>`/`<entry>` elements, so the result would be an empty episode list rather than a crash.

## Security Considerations

**SSRF guard is DNS-unaware (hostname-only check):**
- Risk: `isSafeHost` in `src/feed.ts` blocks known private hostnames and private IPv4 literals, but does NOT perform DNS resolution. A hostname like `evil.example.com` that resolves to `10.0.0.1` would bypass the block.
- Files: `src/feed.ts` (lines 51–90)
- Current mitigation: Blocks known metadata endpoints by hostname (`metadata.google.internal`, `metadata.aws`, etc.) and all raw private IP literals. All IPv6 literals are blocked.
- Recommendations: For production hardening, perform a DNS preflight lookup and validate the resolved IP against the private-range checks before fetching. This is a known pattern for SSRF-safe fetch wrappers.

**`server-only` import in `handlers.ts` and `module.ts` is the only runtime guard against client-side exposure:**
- Risk: If a bundler does not honor `server-only` (e.g., a custom Webpack config without the Next.js plugin), `handlers.ts` and `module.ts` — which import the `@/lib/youtube-api` token provider — could be included in a client bundle, leaking the token acquisition path.
- Files: `src/mcp/handlers.ts`, `src/mcp/module.ts`
- Current mitigation: `import "server-only"` at the top of both files throws at runtime in client contexts under Next.js.
- Recommendations: Acceptable for the current Next.js monorepo target; document that non-Next.js consumers must not import these files on the client.

**.npmrc file present:**
- Existence noted: `.npmrc` is present in the repo root. Contents not read. Likely contains registry configuration or auth token references.

## Performance Bottlenecks

**Feed discovery probes up to 14 well-known paths + 16 `<a href>` candidates sequentially:**
- Problem: `discoverFeedUrl` in `src/feed.ts` tries trusted candidates (which includes ALL 14 well-known paths) one at a time until a valid feed is found. In the worst case this is 30 sequential HTTP fetches, each with a 10-second timeout.
- Files: `src/feed.ts` (lines 224–331)
- Cause: Probes are fired serially; `continue` on failure advances to the next candidate.
- Improvement path: Race the top N trusted candidates (e.g., `<link rel="alternate">` results + direct `.xml`/`.rss` URL) in parallel with `Promise.any`, falling back to sequential well-known probes only if those miss.

**YouTube pagination fetches up to 500 videos (10 pages × 50) before returning:**
- Problem: `YOUTUBE_PAGE_LIMIT = 10` and `YOUTUBE_PAGE_SIZE = 50` in `src/youtube.ts` means up to 10 sequential API calls per request with no early exit once a sufficient number of episodes is collected.
- Files: `src/youtube.ts` (lines 16–17, 232–263)
- Cause: The caller has no way to specify a count limit; the function always exhausts available pages up to the cap.
- Improvement path: Accept an optional `maxEpisodes` parameter and break the pagination loop early once the target is reached.

## Fragile Areas

**`discoverFeedUrl` has no deduplication between the `trusted` Set and well-known paths for the same base URL:**
- Files: `src/feed.ts` (lines 254–275)
- Why fragile: If `websiteUrl` itself is `https://example.com/feed`, it is added to `trusted` both as a direct URL match (line 232) and likely again via the well-known `/feed` path (line 256), resulting in a duplicate probe that wastes one fetch slot.
- Safe modification: The `trusted` Set deduplicates URL strings, so this is benign today but could mask logic bugs if the deduplication is ever removed.
- Test coverage: No test exercises this edge case.

**`buildEpisodeId` and `buildPodcastEpisodeId` use identical hash algorithms but different prefixes:**
- Files: `src/youtube.ts` (lines 75–86), `src/feed.ts` (lines 117–128)
- Why fragile: The logic is copy-pasted. A bug fix or algorithm change in one must be manually mirrored to the other.
- Safe modification: Extract into a shared `src/utils/episode-id.ts` utility.
- Test coverage: Neither function is unit-tested in isolation; they are tested implicitly via the integration tests.

**`normalizeDate` is also duplicated between `feed.ts` and `youtube.ts`:**
- Files: `src/feed.ts` (lines 333–337), `src/youtube.ts` (lines 66–70)
- Why fragile: Same copy-paste concern as above.
- Safe modification: Extract to a shared utility.

## Scaling Limits

**Feed size cap (5 MB):**
- Current capacity: `FETCH_MAX_BYTES = 5 * 1024 * 1024` bytes per fetch response.
- Limit: Podcast feeds larger than 5 MB are rejected with `MEDIA_FEED_PODCAST_FETCH` error. Some high-volume podcasts with thousands of episodes exceed this in their RSS XML.
- Scaling path: Increase cap or implement streaming XML parsing to avoid buffering the full feed in memory.

**YouTube episode cap (500):**
- Current capacity: At most 500 episodes returned (10 pages × 50 per page).
- Limit: Channels with more than 500 uploads silently return only the most recent 500.
- Scaling path: Expose `maxPages` / `maxEpisodes` as optional parameters; document the cap in the MCP tool description.

## Dependencies at Risk

**`cheerio ^1.2.0` — major version recently released:**
- Risk: Cheerio 1.x introduced breaking API changes from 0.x. The caret range (`^1.2.0`) allows minor/patch updates but the package is actively maintained with potential future breaking changes.
- Impact: Feed parsing in `src/feed.ts` depends on the cheerio 1.x XML-mode API.
- Migration plan: Pin to a specific minor version if stability is critical; monitor cheerio changelog.

**`zod ^4.3.6` — pinned to Zod v4 which is a recent major:**
- Risk: Zod v4 has a different API surface from v3. The caret allows patch updates only within v4. If the monorepo's other packages use Zod v3, there could be version conflicts when installed together.
- Impact: Schema validation in `src/mcp/schemas.ts`.
- Migration plan: Confirm monorepo's Zod version alignment; consider using `^3.x` if the monorepo has not fully migrated.

## Missing Critical Features

**No retry logic on transient network failures:**
- Problem: `fetchText` and `fetchYouTubeJSON` throw immediately on any non-2xx response or network error with no retry.
- Blocks: Reliable operation against rate-limited or intermittently failing podcast feeds and YouTube API endpoints.

**No `maxEpisodes` parameter for YouTube listing:**
- Problem: There is no way to ask for only the latest N YouTube videos without fetching all pages up to the 500-episode cap.
- Blocks: Low-latency use cases where only recent episodes are needed.

## Test Coverage Gaps

**`src/mcp/handlers.ts`, `src/mcp/registry.ts`, `src/mcp/module.ts` — completely untested:**
- What's not tested: MCP handler dispatch, Zod schema validation at the handler boundary, `registerMediaFeedsPrimitives` tool registration, `structuredContent` shape construction.
- Files: `src/mcp/handlers.ts`, `src/mcp/registry.ts`, `src/mcp/module.ts`
- Risk: Schema validation regressions and MCP result shape changes would not be caught until runtime.
- Priority: High

**`src/url-classifier.ts` — partial coverage:**
- What's not tested: `music.youtube.com` host, `m.youtube.com` host, HTTP (non-HTTPS) YouTube URLs, bare `/` path on youtube.com.
- Files: `src/__tests__/url-classifier.test.ts`
- Risk: A regression allowing individual video URLs from `music.youtube.com` to be classified as `"youtube"` channel URLs would not be caught.
- Priority: Medium

**Feed discovery fallback paths (well-known probes and `<a href>` candidates) — not tested:**
- What's not tested: The 14 well-known path probes, the `UNTRUSTED_A_HREF_CANDIDATE_CAP` enforcement, discovery via `<a href>` text heuristics.
- Files: `src/__tests__/feed.test.ts`, `src/feed.ts`
- Risk: Regressions in the multi-hop discovery logic would not surface until live feeds are tested manually.
- Priority: Medium

**`src/errors.ts` — not tested:**
- What's not tested: `MediaFeedError` constructor, `name` property, `code` property typing.
- Files: `src/errors.ts`
- Risk: Low — simple class; tested implicitly by all other test suites.
- Priority: Low

---

*Concerns audit: 2026-06-09*
