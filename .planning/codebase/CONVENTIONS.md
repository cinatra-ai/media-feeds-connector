# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- `kebab-case.ts` for all source files: `url-classifier.ts`, `feed.ts`, `youtube.ts`, `errors.ts`
- Test files live in `src/__tests__/` with the suffix `.test.ts`: `url-classifier.test.ts`, `feed.test.ts`, `youtube.test.ts`
- MCP sub-module files use single-word noun names: `module.ts`, `schemas.ts`, `handlers.ts`, `registry.ts`

**Functions:**
- `camelCase` for all functions: `classifyMediaFeedUrl`, `scrapePodcastEpisodes`, `scrapeYouTubeChannelEpisodes`, `fetchText`, `discoverFeedUrl`, `isSafeHost`
- Factory functions prefixed with `create`: `createMediaFeedsPrimitiveHandlers`, `createMediaFeedsModule`
- Registration functions prefixed with `register`: `registerMediaFeedsPrimitives`
- Boolean-returning helpers prefixed with `is` or `looks`: `isPrivateIpv4`, `isSafeHost`, `looksLikeFeed`
- Internal builder helpers prefixed with `build`: `buildPodcastEpisodeId`, `buildEpisodeId`

**Variables:**
- `camelCase` for local vars, constants, and module-level `const`
- Module-level constants use `SCREAMING_SNAKE_CASE`: `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES`, `USER_AGENT`, `BLOCKED_HOSTS`, `YOUTUBE_API_BASE`, `YOUTUBE_PAGE_LIMIT`, `YOUTUBE_PAGE_LIMIT`, `UNTRUSTED_A_HREF_CANDIDATE_CAP`

**Types:**
- PascalCase type aliases and interfaces: `MediaFeedClassification`, `ScrapedEpisode`, `YouTubeEpisode`, `ScrapeYouTubeChannelResult`, `MediaFeedErrorCode`
- Exported types use `export type` (enforced by `verbatimModuleSyntax` in `tsconfig.json`)
- Error codes are `as const` arrays with a derived union type, e.g. `MEDIA_FEED_ERROR_CODES` → `MediaFeedErrorCode`
- Zod inferred types are named with suffix `Input`: `YouTubeListInput`, `PodcastListInput` (`src/mcp/schemas.ts`)

## Code Style

**Formatting:**
- Not detected (no `.prettierrc`, `.biome.json`, or `eslint.config.*` in repo root). Indentation is 2 spaces throughout.

**Linting:**
- Not detected (no `eslint.config.*` or `.eslintrc*`). TypeScript `strict: true` is the primary static guard.

**TypeScript strictness:**
- `strict: true` with `noImplicitAny: false` (intentional relaxation) — see `tsconfig.json`
- `isolatedModules: true` and `verbatimModuleSyntax: true` enforce explicit `import type` for type-only imports
- `target: ES2023`, `module: ESNext`, `moduleResolution: bundler`

## Import Organization

**Order (observed pattern):**
1. `"server-only"` guard (where applicable, e.g. `src/mcp/handlers.ts`)
2. External packages (`cheerio`, `zod`, `node:net`, `node:path`)
3. Internal relative imports (`"../errors"`, `"./url-classifier"`, `"./schemas"`)
4. Host-side alias imports (`@/lib/youtube-api`) — only in handler, kept isolated to MCP layer

**Path Aliases:**
- `@/` maps to the monorepo root `src/` directory at test time (configured in `vitest.config.ts`); not a runtime alias — for production host integration only

## Error Handling

**Pattern:** All public functions throw `MediaFeedError` (defined in `src/errors.ts`) with a typed `code: MediaFeedErrorCode` field. Never throw plain `Error` or string.

**Error codes** are `as const` string literals prefixed by domain: `MEDIA_FEED_YOUTUBE_*`, `MEDIA_FEED_PODCAST_*`. Full list in `src/index.ts` and `src/errors.ts`.

**Try/catch usage:**
- URL parsing failures caught locally and converted to `MediaFeedError` or `"unsupported"` return value
- Network errors in `fetchText` propagate via `MediaFeedError` with `MEDIA_FEED_PODCAST_FETCH`
- XML parse errors caught and rethrown as `MediaFeedError` with `MEDIA_FEED_PODCAST_PARSE`
- Empty `catch` blocks only on cleanup paths (`await reader.cancel(...).catch(() => {})`, `await response.body?.cancel()`)

**Zod validation:**
- Input schemas parsed with `.parse()` (throws `ZodError` on invalid input) in `src/mcp/handlers.ts`
- Schemas defined in `src/mcp/schemas.ts` and not re-exported from the public surface

## Logging

**Framework:** None — no logging library detected. No `console.log` calls present in source.

## Comments

**When to Comment:**
- File-level block comments (using `//`) describe SSRF guards, API design decisions, and invariants before implementation begins — see `src/feed.ts`, `src/youtube.ts`, `src/url-classifier.ts`
- Inline comments explain non-obvious logic: redirect hop guards, bracket-stripping for IPv6, untrusted candidate cap rationale
- `// Emit X instead of Y` style comments document outward-facing contract decisions

**JSDoc/TSDoc:**
- Not used. Prose comments used instead for the same explanatory purpose.

## Function Design

**Size:** Functions are focused. Complex logic is extracted: `isSafeHost`, `ensureSafeUrl`, `discoverFeedUrl`, `fetchText` are all standalone private functions.

**Parameters:** Public functions take a single typed `input` object argument. Private helpers use positional args where the surface is small.

**Return Values:** Async functions return typed `Promise<T>` result objects. Pure classifiers return discriminated union string literals (`"youtube" | "podcast" | "unsupported"`).

## Module Design

**Exports:** `src/index.ts` is the single public barrel. All internal modules use named exports only — no default exports detected.

**Barrel Files:** One barrel at `src/index.ts`. The `src/mcp/` sub-directory does not have its own barrel; each file is imported directly from `src/index.ts`.

**Server isolation:** `src/mcp/handlers.ts` uses `import "server-only"` to prevent accidental client-side bundling of the host-integrated handler.

---

*Convention analysis: 2026-06-09*
