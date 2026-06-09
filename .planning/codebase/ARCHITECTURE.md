<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────────┐
│                    MCP / Connector Layer                         │
│  `src/mcp/registry.ts`  `src/mcp/handlers.ts`  `src/mcp/module.ts` │
│  Registers MCP tools, validates input with Zod, routes to core   │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Core Logic Layer                            │
├──────────────────────┬───────────────────────────────────────────┤
│  YouTube scraper     │  Podcast RSS scraper                      │
│  `src/youtube.ts`    │  `src/feed.ts`                            │
│  YouTube Data API v3 │  HTTP fetch + cheerio RSS/Atom parse      │
└──────────────────────┴───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Shared Utilities                               │
│  `src/url-classifier.ts`  — classify URL as youtube/podcast      │
│  `src/errors.ts`          — MediaFeedError + typed error codes   │
└──────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                   External Systems                               │
│  YouTube Data API v3 (googleapis.com)                            │
│  Podcast website + RSS/Atom feed (arbitrary HTTP/HTTPS)          │
│  Nango OAuth — YouTube access token (injected via tokenProvider) │
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| MCP Registry | Register tools with MCP server, attach Zod schemas + descriptions | `src/mcp/registry.ts` |
| MCP Handlers | Validate input, call core scrapers, return raw results | `src/mcp/handlers.ts` |
| MCP Module | Factory returning `{ registerCapabilities }` for platform mount | `src/mcp/module.ts` |
| MCP Schemas | Zod schemas for `youtubeListSchema` and `podcastListSchema` | `src/mcp/schemas.ts` |
| YouTube scraper | Classify URL, resolve channel handle/id, paginate playlistItems | `src/youtube.ts` |
| Podcast scraper | SSRF-safe fetch, RSS/Atom discovery heuristics, episode parse | `src/feed.ts` |
| URL classifier | Classify URL as `youtube`, `podcast`, or `unsupported` | `src/url-classifier.ts` |
| Error types | Typed `MediaFeedError` with structured error codes | `src/errors.ts` |
| Public API | Re-exports all public types and functions | `src/index.ts` |

## Pattern Overview

**Overall:** Layered connector — thin MCP adapter wrapping pure async scraping functions with dependency-injected auth.

**Key Characteristics:**
- No framework (no Express, no Next.js routes) — all logic is plain TypeScript functions
- `server-only` import guard in MCP layer prevents accidental client-side bundling
- Auth (`YouTubeTokenProvider`) is injected at call-site, not hard-coded; enables unit-test mocking without faking OAuth
- SSRF defenses built into `src/feed.ts`: per-hop URL validation, private CIDR blocklist, redirect cap (4 hops), byte cap (5 MB), 10s abort timeout
- Error handling uses typed `MediaFeedError` class with enum-style string codes; callers can `instanceof` check or switch on `.code`

## Layers

**MCP Adapter Layer:**
- Purpose: Expose scraping functions as MCP tools consumable by the Cinatra agent platform
- Location: `src/mcp/`
- Contains: Tool registration, Zod input validation, static tool metadata, `server-only` guard
- Depends on: core scrapers (`src/youtube.ts`, `src/feed.ts`), `@cinatra-ai/sdk-extensions`
- Used by: Cinatra platform MCP server at mount time

**Core Scraping Layer:**
- Purpose: Implement the actual data retrieval from YouTube API and podcast RSS feeds
- Location: `src/youtube.ts`, `src/feed.ts`
- Contains: HTTP fetch helpers, API pagination, XML/HTML parsing, episode normalization
- Depends on: `src/url-classifier.ts`, `src/errors.ts`, `cheerio` (podcast only)
- Used by: MCP handlers (`src/mcp/handlers.ts`) and directly by consumers via public API

**Shared Utilities:**
- Purpose: Cross-cutting helpers reused by both scrapers
- Location: `src/url-classifier.ts`, `src/errors.ts`
- Contains: URL classification logic, error class + code enum
- Depends on: nothing internal
- Used by: both core scrapers

## Data Flow

### YouTube Channel Listing

1. MCP tool `media_feed_youtube_list` invoked — input parsed by `youtubeListSchema` (`src/mcp/schemas.ts`)
2. Handler delegates to `scrapeYouTubeChannelEpisodes(input, getConfiguredYouTubeAccessToken)` (`src/mcp/handlers.ts:13`)
3. URL validated by `classifyMediaFeedUrl` — rejects non-channel URLs (`src/youtube.ts:219`)
4. `getChannelLookupFromUrl` extracts handle/id/username from path (`src/youtube.ts:88`)
5. `fetchChannel` calls `GET /channels` on YouTube Data API v3 to resolve uploads playlist ID (`src/youtube.ts:180`)
6. Paginated `GET /playlistItems` loop (up to 10 pages × 50 items) collects episodes (`src/youtube.ts:232`)
7. Returns `ScrapeYouTubeChannelResult` with normalized `YouTubeEpisode[]`

### Podcast Episode Listing

1. MCP tool `media_feed_podcast_list` invoked — input parsed by `podcastListSchema` (`src/mcp/schemas.ts`)
2. Handler delegates to `scrapePodcastEpisodes(input)` (`src/mcp/handlers.ts:16`)
3. `discoverFeedUrl` fetches website HTML, probes `<link rel="alternate">`, `<a href>` candidates, and 14 well-known feed paths (`src/feed.ts:224`)
4. Each candidate is fetched with SSRF-safe `fetchText` (per-hop validation, redirect cap, byte cap) (`src/feed.ts:142`)
5. First valid RSS/Atom document returned; cheerio parses `<item>` / `<entry>` elements (`src/feed.ts:371`)
6. Episodes filtered by `filterMode` (`latest` or `date_range`) and sorted by `publishedAt` DESC
7. Returns `ScrapePodcastEpisodesResult` with normalized `ScrapedEpisode[]`

**State Management:**
- Stateless — no module-level mutable state. Each invocation is fully self-contained. The YouTube token is fetched fresh per call via `tokenProvider()`.

## Key Abstractions

**YouTubeTokenProvider:**
- Purpose: Injectable async function that returns the OAuth access token string (or null)
- Examples: `src/youtube.ts:64` (type), `src/mcp/handlers.ts:13` (injected as `getConfiguredYouTubeAccessToken`)
- Pattern: Dependency injection — decouples auth retrieval from scraping logic; enables unit test mocking

**MediaFeedError:**
- Purpose: Typed error carrying a machine-readable `code` (one of 10 defined `MediaFeedErrorCode` values)
- Examples: `src/errors.ts`
- Pattern: Subclasses `Error`; callers `instanceof MediaFeedError` or switch on `.code` for structured error handling

**MediaFeedClassification:**
- Purpose: Union type `"youtube" | "podcast" | "unsupported"` returned by URL classifier
- Examples: `src/url-classifier.ts:12`
- Pattern: Pure function classifier; YouTube scraper re-runs classification to prevent bypass

## Entry Points

**Public Library API:**
- Location: `src/index.ts`
- Triggers: `import { ... } from "@cinatra-ai/media-feeds-connector"` by host application
- Responsibilities: Re-exports all public functions, types, and MCP factory functions

**MCP Module Factory:**
- Location: `src/mcp/module.ts`
- Triggers: Called by Cinatra platform during connector mount
- Responsibilities: Returns `{ registerCapabilities: registerMediaFeedsPrimitives }` for platform registration

**MCP Tool Handlers:**
- Location: `src/mcp/handlers.ts`
- Triggers: Per-tool invocation from MCP server at runtime
- Responsibilities: Validate input with Zod, call core scraper, return result

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop. No worker threads. All async I/O via `fetch` with `AbortController` timeouts.
- **Global state:** None. No module-level singletons or shared mutable state.
- **Circular imports:** None detected. Dependency direction is strictly: `mcp/` → `core` → `utilities`.
- **server-only guard:** `src/mcp/module.ts`, `src/mcp/handlers.ts`, `src/mcp/registry.ts` all import `"server-only"` — MCP layer must never be bundled for browser/client.
- **Peer dependency:** `@cinatra-ai/sdk-extensions` is an optional peer dep; `src/mcp/` imports from it but core scrapers do not, so `src/youtube.ts` and `src/feed.ts` are importable without the SDK.

## Anti-Patterns

### Bypassing URL Classifier

**What happens:** A caller passes a non-channel YouTube URL (e.g., `/watch?v=...`) directly to `scrapeYouTubeChannelEpisodes`.
**Why it's wrong:** The YouTube Data API `/playlistItems` endpoint does not accept video URLs — the request would fail or silently return no results.
**Do this instead:** The classifier is re-run inside `scrapeYouTubeChannelEpisodes` at `src/youtube.ts:219` — do not skip or move this guard.

### Importing MCP Layer in Client Code

**What happens:** A Next.js client component imports from `src/mcp/handlers.ts` or `src/mcp/registry.ts`.
**Why it's wrong:** These files contain `import "server-only"` — Next.js will throw a build error preventing client-side bundling.
**Do this instead:** Import only from `src/index.ts` and use the core scraper functions directly; MCP layer is server/platform only.

## Error Handling

**Strategy:** Throw `MediaFeedError` with typed `code` for all recoverable domain errors; let unexpected errors propagate as native `Error`.

**Patterns:**
- All public scraper functions throw `MediaFeedError` on invalid input, network failure, or parse failure
- MCP handlers do not catch errors — the MCP server framework handles transport-level error serialization
- 10 typed error codes defined in `src/errors.ts`; callers can branch on `.code` for user-facing messages

## Cross-Cutting Concerns

**Logging:** Not implemented — no logger framework. Errors surface via thrown `MediaFeedError`.
**Validation:** Zod schemas in `src/mcp/schemas.ts` validate MCP tool inputs; URL validation done inline in scrapers.
**Authentication:** YouTube auth via injected `YouTubeTokenProvider`; podcast scraping is unauthenticated but SSRF-guarded.

---

*Architecture analysis: 2026-06-09*
