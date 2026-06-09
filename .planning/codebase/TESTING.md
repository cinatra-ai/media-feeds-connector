# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (version inferred from `vitest.config.ts` import; pinned via `package.json` devDependencies)
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in (`expect` from `vitest`)

**Run Commands:**
```bash
npm test          # Run all tests (vitest)
npx vitest --watch   # Watch mode
npx vitest --coverage  # Coverage (not yet configured)
```

## Test File Organization

**Location:**
- All tests are co-located in `src/__tests__/` (separate subdirectory, not alongside source files)

**Naming:**
- `<source-module>.test.ts` mirrors the source filename: `url-classifier.test.ts`, `feed.test.ts`, `youtube.test.ts`

**Structure:**
```
src/
├── __tests__/
│   ├── url-classifier.test.ts
│   ├── feed.test.ts
│   └── youtube.test.ts
└── *.ts   (source modules)
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("<module> — <concern>", () => {
  it("<specific behaviour>", async () => {
    // arrange, act, assert
  });
});
```

Each test file groups related test cases into multiple `describe` blocks named with the pattern `"<functionName> — <scenario group>"`, e.g. `"scrapeYouTubeChannelEpisodes — auth + error mapping"`, `"classifyMediaFeedUrl — YouTube acceptance"`.

**Patterns:**
- Parametric table tests use `it.each([...])` with a description string containing `%s` for the varying value
- Async tests use `async/await` throughout; no callback-style tests
- Error assertions use `await expect(fn()).rejects.toMatchObject({ code: "..." })` — partial object matching against `MediaFeedError.code`

## Mocking

**Framework:** Vitest built-in (`vi.fn()`, `vi.mock()`)

**Pattern — global fetch replacement:**
```typescript
const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});
```
The real `fetch` is saved and restored around each test. This pattern appears in both `feed.test.ts` and `youtube.test.ts`.

**Response factory helpers** (defined at test file top-level, not shared):
```typescript
function okText(body: string, contentType = "text/html"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

// YouTube-specific:
function ok<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, ... });
}
```

**Sequential mock responses:**
```typescript
fetchMock
  .mockResolvedValueOnce(okText(htmlPage))     // first fetch: HTML page
  .mockResolvedValueOnce(okText(rssXml, "application/rss+xml")); // second: RSS
```

**What to Mock:**
- `globalThis.fetch` only — the network boundary
- The `server-only` package is stubbed in `vitest.config.ts` via alias to avoid Next.js server-only guard errors in the test environment

**What NOT to Mock:**
- Internal parsing logic (`cheerio`, URL parsing, episode ID hashing)
- `classifyMediaFeedUrl` — called as a real dependency inside `youtube.ts` tests

## Fixtures and Factories

**Test Data:**
```typescript
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Test Podcast</title>
    <item>
      <title>Episode 3</title>
      <enclosure url="https://media.example.com/ep3.mp3" .../>
      <pubDate>Mon, 03 May 2026 10:00:00 GMT</pubDate>
    </item>
    ...
  </channel>
</rss>`;
```
Fixtures are module-level constants defined at the top of each test file. No shared fixture files or factory libraries are used.

**Location:**
- Inline in each test file — no separate `__fixtures__/` directory

## Coverage

**Requirements:** Not enforced (no coverage threshold in `vitest.config.ts`)

**View Coverage:**
```bash
npx vitest --coverage
```

## Test Types

**Unit Tests:**
- Pure function tests: `url-classifier.test.ts` tests `classifyMediaFeedUrl` with no mocks — 100% pure input/output
- Network-boundary unit tests: `feed.test.ts` and `youtube.test.ts` mock `fetch` and test full module logic end-to-end within a single function call

**Integration Tests:**
- Not applicable — no separate integration test layer. The mock-fetch tests cover multi-hop redirect logic, pagination, and feed discovery heuristics, approximating integration coverage.

**E2E Tests:**
- Not used

## Common Patterns

**Async Testing:**
```typescript
it("description", async () => {
  fetchMock.mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml"));
  const result = await scrapePodcastEpisodes({ websiteUrl: "https://example.com/feed.xml" });
  expect(result.episodes).toHaveLength(3);
});
```

**Error Testing:**
```typescript
it("rejects unsafe URL upfront", async () => {
  await expect(
    scrapePodcastEpisodes({ websiteUrl: "http://localhost/feed" })
  ).rejects.toMatchObject({ code: "MEDIA_FEED_PODCAST_INVALID_URL" });
  expect(fetchMock).not.toHaveBeenCalled();
});
```
The `.not.toHaveBeenCalled()` assertion after error tests is used to verify that validation short-circuits before any network call is made.

**Boundary / budget tests:**
```typescript
it("caps untrusted <a href> candidates at 16", async () => {
  // ...setup 64 decoy links...
  await expect(fn()).rejects.toMatchObject({ code: "MEDIA_FEED_PODCAST_NO_FEED" });
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + 15 + 16);
  expect(fetchMock.mock.calls.length).toBeLessThan(N);
});
```
Used to verify security-critical fan-out caps and pagination limits.

## Vitest Configuration Notes

`vitest.config.ts` configures two aliases for the test environment:
- `server-only` → stub at `<repo-root>/tests/__stubs__/server-only.ts` (prevents server-only guard from throwing)
- `@/` → `<repo-root>/src/` (matches the Next.js path alias used by `src/mcp/handlers.ts` at runtime)

Both are required because this connector is extracted from a monorepo and the handler imports host-side code that must be stubbed during isolated unit testing.

---

*Testing analysis: 2026-06-09*
