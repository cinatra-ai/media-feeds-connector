# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
media-feeds-connector/
├── src/                    # All source code
│   ├── index.ts            # Public API barrel — re-exports everything
│   ├── url-classifier.ts   # URL classification (youtube/podcast/unsupported)
│   ├── youtube.ts          # YouTube Data API v3 channel scraper
│   ├── feed.ts             # Podcast RSS/Atom discovery and episode parser
│   ├── errors.ts           # MediaFeedError class + typed error codes
│   ├── mcp/                # MCP adapter layer (server-only)
│   │   ├── module.ts       # Connector mount factory
│   │   ├── registry.ts     # MCP tool registration with descriptions
│   │   ├── handlers.ts     # Per-tool request handlers
│   │   └── schemas.ts      # Zod input schemas for MCP tools
│   └── __tests__/          # Co-located test directory
│       ├── feed.test.ts    # Podcast scraper tests
│       ├── url-classifier.test.ts  # URL classifier tests
│       └── youtube.test.ts # YouTube scraper tests
├── .github/
│   └── workflows/
│       ├── ci.yml          # CI pipeline
│       └── release.yml     # Release workflow
├── package.json            # Package manifest with cinatra connector metadata
├── tsconfig.json           # TypeScript configuration
├── vitest.config.ts        # Vitest test runner config
├── .npmrc                  # npm registry config
└── LICENSE                 # Apache-2.0
```

## Directory Purposes

**`src/`:**
- Purpose: All library source code — scrapers, utilities, MCP adapter
- Contains: TypeScript `.ts` files only; no build output committed
- Key files: `src/index.ts` (public API), `src/youtube.ts`, `src/feed.ts`

**`src/mcp/`:**
- Purpose: MCP tool registration and request handling — platform integration layer
- Contains: Server-only files that must not be bundled for browser/client
- Key files: `src/mcp/registry.ts` (tool registration), `src/mcp/handlers.ts` (request routing)

**`src/__tests__/`:**
- Purpose: All unit/integration tests
- Contains: Vitest test files named `<module>.test.ts`
- Key files: `src/__tests__/feed.test.ts`, `src/__tests__/youtube.test.ts`, `src/__tests__/url-classifier.test.ts`

**`.github/workflows/`:**
- Purpose: CI/CD automation
- Contains: YAML workflow definitions for testing and releasing

## Key File Locations

**Entry Points:**
- `src/index.ts`: Public library barrel — the only file consumers should import from

**Configuration:**
- `package.json`: Package name (`@cinatra-ai/media-feeds-connector`), version, cinatra connector metadata (`kind: connector`)
- `tsconfig.json`: TypeScript compiler settings
- `vitest.config.ts`: Test runner configuration

**Core Logic:**
- `src/youtube.ts`: YouTube channel episode fetching via YouTube Data API v3
- `src/feed.ts`: Podcast RSS/Atom feed discovery and episode parsing
- `src/url-classifier.ts`: URL classification helper (pure function, no I/O)
- `src/errors.ts`: `MediaFeedError` class with 10 typed error codes

**MCP Integration:**
- `src/mcp/schemas.ts`: Zod input validation schemas
- `src/mcp/handlers.ts`: Maps tool names to scraper function calls
- `src/mcp/registry.ts`: Registers tools with descriptions on MCP server
- `src/mcp/module.ts`: Top-level factory returning `{ registerCapabilities }`

**Testing:**
- `src/__tests__/`: All test files

## Naming Conventions

**Files:**
- kebab-case for all source files: `url-classifier.ts`, `youtube.ts`, `feed.ts`
- Test files: `<module-name>.test.ts` placed in `src/__tests__/`
- MCP sub-layer files: descriptive nouns — `module.ts`, `registry.ts`, `handlers.ts`, `schemas.ts`

**Directories:**
- `__tests__` (double underscore): standard Jest/Vitest convention for test directory
- `mcp/`: named after the protocol it implements

**Types:**
- PascalCase for all exported types and interfaces: `MediaFeedClassification`, `YouTubeEpisode`, `ScrapePodcastEpisodesResult`
- Zod schemas: camelCase with `Schema` suffix: `youtubeListSchema`, `podcastListSchema`
- Error codes: `UPPER_SNAKE_CASE` string literals: `"MEDIA_FEED_YOUTUBE_AUTH"`, `"MEDIA_FEED_PODCAST_FETCH"`

**Functions:**
- camelCase, verb-first: `scrapeYouTubeChannelEpisodes`, `scrapePodcastEpisodes`, `classifyMediaFeedUrl`, `createMediaFeedsModule`, `registerMediaFeedsPrimitives`

## Where to Add New Code

**New media source scraper (e.g., Spotify, Vimeo):**
- Implementation: `src/<source-name>.ts` (e.g., `src/spotify.ts`)
- Export from: `src/index.ts`
- Add URL classification variant to: `src/url-classifier.ts` (`MediaFeedClassification` union type)
- Add MCP handler entry to: `src/mcp/handlers.ts`
- Add Zod schema to: `src/mcp/schemas.ts`
- Register MCP tool in: `src/mcp/registry.ts`
- Tests: `src/__tests__/<source-name>.test.ts`

**New utility / shared helper:**
- Implementation: `src/<utility-name>.ts`
- Export from `src/index.ts` if public-facing

**New error code:**
- Add to the `MEDIA_FEED_ERROR_CODES` array in `src/errors.ts`

**New MCP tool input field:**
- Add to the appropriate Zod schema in `src/mcp/schemas.ts`
- Update handler in `src/mcp/handlers.ts` to pass new field to scraper

## Special Directories

**`src/__tests__/`:**
- Purpose: Vitest test files
- Generated: No
- Committed: Yes

**`.planning/`:**
- Purpose: GSD planning and codebase analysis documents
- Generated: Yes (by GSD tooling)
- Committed: Project-dependent (not in .gitignore by default)

---

*Structure analysis: 2026-06-09*
