# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**YouTube Data API v3:**
- Used to list a channel's uploads playlist (channel lookup + playlist items pagination)
- Base URL: `https://www.googleapis.com/youtube/v3` (hardcoded in `src/youtube.ts`)
- Auth: OAuth Bearer token — retrieved at runtime via `getConfiguredYouTubeAccessToken` from `@/lib/youtube-api` (host-app module, not in this package)
- Token lifecycle (refresh, revocation) is managed by Nango OAuth platform in the host application
- Endpoints used: `/channels` (channel lookup by handle/id/username), `/playlistItems` (paginated uploads)
- Page size: 50 items, max 10 pages per call (500 videos max) — constants in `src/youtube.ts`

**Podcast RSS/Atom Feeds (arbitrary public URLs):**
- No fixed API — fetches arbitrary public podcast website URLs and RSS/Atom feed URLs
- Discovery logic in `src/feed.ts`: tries `<link rel="alternate">`, 15 well-known feed paths, and capped `<a href>` candidates
- HTTP client: native `fetch` with 10 s timeout (`AbortController`), 5 MB response cap, `redirect: "manual"` with per-hop SSRF validation
- User-Agent: `Cinatra Media Feed Lister/0.1`
- Supports RSS 2.0 (`<item>`) and Atom (`<entry>`) formats; parses `<enclosure>` and `<media:content>` for audio URLs; reads `<itunes:*>` namespace fields

## Data Storage

**Databases:**
- Not applicable — this package is stateless; it fetches and returns structured data without persistence

**File Storage:**
- Not applicable

**Caching:**
- None — all fetches use `cache: "no-store"`

## Authentication & Identity

**Auth Provider:**
- Nango OAuth (managed by host application)
  - Implementation: `YouTubeTokenProvider` callback type (`src/youtube.ts`) — callers inject a `() => Promise<string | null>` token provider; production wiring uses `getConfiguredYouTubeAccessToken` from `@/lib/youtube-api` (`src/mcp/handlers.ts`)
  - Missing/expired token throws `MEDIA_FEED_YOUTUBE_KEY_MISSING`; quota/forbidden throws `MEDIA_FEED_YOUTUBE_QUOTA` or `MEDIA_FEED_YOUTUBE_AUTH`

## Monitoring & Observability

**Error Tracking:**
- Not applicable — errors are surfaced as typed `MediaFeedError` instances (`src/errors.ts`) with structured error codes; no external error-tracking SDK

**Logs:**
- None — no logging framework; errors propagate to the MCP handler layer in the host application

## CI/CD & Deployment

**Hosting:**
- Deployed as part of a Next.js server-side application (enforced by `import "server-only"` in `src/mcp/module.ts` and `src/mcp/handlers.ts`)

**CI Pipeline:**
- `.github/` directory present — specific workflow files not inspected, but repository has GitHub Actions configuration

## Environment Configuration

**Required env vars (host application, not this package):**
- YouTube OAuth access token is retrieved via `getConfiguredYouTubeAccessToken` — the underlying env var name is defined in the host app's `@/lib/youtube-api` module, not in this connector

**Secrets location:**
- No secrets stored in this package; `.npmrc` present (registry config only, not read for content)

## Webhooks & Callbacks

**Incoming:**
- Not applicable

**Outgoing:**
- Not applicable — connector only makes outbound HTTP GETs to YouTube Data API and public podcast feed URLs

## SSRF Mitigations

Implemented in `src/feed.ts` for podcast URL fetching:
- Blocklist: `localhost`, `metadata.google.internal`, `metadata.aws`, `metadata.azure.com`
- Private IPv4 CIDR ranges blocked: 10.x, 127.x, 169.254.x, 172.16–31.x, 192.168.x, 0.x, 100.64–127.x (CGNAT), 224+ (multicast/reserved)
- All IPv6 literals blocked (conservative)
- Only `http:` and `https:` schemes allowed
- Redirect chain validated per-hop (up to 4 hops), `redirect: "manual"`

---

*Integration audit: 2026-06-09*
