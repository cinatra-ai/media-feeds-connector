# Media Feeds

Pull a structured episode list out of any YouTube channel or podcast website so downstream agents can pick what to transcribe, summarize, or analyse. Hand in a channel URL or a podcast site URL and get back a uniform list of uploads or episodes with titles, links, media URLs, and publish timestamps.

**Install** — add the connector from the Cinatra marketplace via your workspace Extensions page.

**Configuration** — YouTube requires an OAuth connection configured at `/configuration/llm` via Nango before calling the YouTube tool; the connector mints a short-lived bearer on each call and stores no static key. Podcast listing requires no credentials.

**Usage** — `media_feed_youtube_list` accepts `{ "channelUrl": "https://www.youtube.com/@handle" }` and returns up to 500 uploads. Accepted: `/@handle`, `/channel/UC…`, `/user/<name>`, `/c/<slug>`. Rejected: `/watch`, `/shorts`, `/playlist`, `youtu.be`. `media_feed_podcast_list` accepts `{ "websiteUrl": "https://example.com/podcast" }` and discovers the RSS/Atom feed automatically. Add `"filterMode": "latest"` with `"latestCount": 5` for the newest five, or `"filterMode": "date_range"` with `"dateFrom"` / `"dateTo"` (YYYY-MM-DD) to bracket by date. Both tools return `{ id, title, link, mediaUrl, publishedAt?, description?, duration? }` per episode.

**API contract** — `media_feed_youtube_list` returns `{ channelTitle, channelUrl, episodes[] }`. `media_feed_podcast_list` accepts `latestCount` 1–50 (default 10) and returns `{ podcastTitle, websiteUrl, feedUrl, episodes[] }`.

**Development** — run `npm install` then `npm test` (Vitest, TypeScript ESM, no build step). Entry points: `./src/index.ts` (public API), `./register` (host activation), `./mcp-handlers` (MCP primitives).

**Troubleshooting** — `YouTube is not connected`: configure OAuth at `/configuration/llm`. `YouTube API 401`: token expired — reconnect. `YouTube API 403` quota/rate: daily quota exhausted, resets midnight Pacific. `Unable to discover a podcast feed`: pass the direct `.xml` URL instead of the homepage. `Hostname blocked`: only public HTTP/HTTPS is accepted; private and loopback addresses are rejected.

## Works with

- YouTube
- Podcast RSS and Atom feeds

## Capabilities

- List uploads from a YouTube channel by URL
- List recent episodes from a podcast by its website URL
- Filter podcast episodes to the latest N or to a publish-date range
- Discover a show's feed automatically from its public website
