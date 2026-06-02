import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scrapePodcastEpisodes } from "../feed";

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function okText(body: string, contentType = "text/html"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Test Podcast</title>
    <item>
      <title>Episode 3</title>
      <link>https://example.com/ep3</link>
      <enclosure url="https://media.example.com/ep3.mp3" type="audio/mpeg" length="12345"/>
      <pubDate>Mon, 03 May 2026 10:00:00 GMT</pubDate>
      <description>Third episode</description>
    </item>
    <item>
      <title>Episode 2</title>
      <enclosure url="https://media.example.com/ep2.mp3" type="audio/mpeg" length="1"/>
      <pubDate>Mon, 02 May 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Episode 1</title>
      <enclosure url="https://media.example.com/ep1.mp3" type="audio/mpeg" length="1"/>
      <pubDate>Mon, 01 May 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe("scrapePodcastEpisodes — SSRF guards (bracket-stripping fix)", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/feed.xml",
    "http://localhost/feed",
    "http://127.0.0.1/feed",
    "http://10.0.0.1/feed",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://192.168.1.1/feed",
    "http://metadata.google.internal/foo",
    // IPv6 literal bracket-stripping: Node's URL.hostname keeps the brackets;
    // isIP("[::1]") === 0, so stripBrackets() is needed before the IP guard.
    "http://[::1]/feed",
    "http://[::]/feed",
    "http://[fc00::1]/feed",
    "http://[fe80::1]/feed",
    "http://[::ffff:127.0.0.1]/feed",
  ])("rejects unsafe URL %s upfront", async (rawUrl) => {
    await expect(scrapePodcastEpisodes({ websiteUrl: rawUrl })).rejects.toMatchObject({
      code: "MEDIA_FEED_PODCAST_INVALID_URL",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("scrapePodcastEpisodes — feed discovery", () => {
  it("uses direct .xml URL as feed", async () => {
    fetchMock.mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
      filterMode: "latest",
      latestCount: 10,
    });
    expect(result.feedUrl).toBe("https://example.com/feed.xml");
    expect(result.podcastTitle).toBe("The Test Podcast");
  });

  it("discovers feed via <link rel=alternate type=rss>", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okText(
          `<html><head><link rel="alternate" type="application/rss+xml" href="https://example.com/rss"/></head><body></body></html>`,
        ),
      )
      .mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/show",
      filterMode: "latest",
      latestCount: 10,
    });
    expect(result.feedUrl).toBe("https://example.com/rss");
  });

  it("falls back to /feed well-known path when no <link> hint", async () => {
    fetchMock
      .mockResolvedValueOnce(okText("<html><body>no hints here</body></html>"))
      .mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml")); // /feed succeeds
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/",
      filterMode: "latest",
      latestCount: 10,
    });
    expect(result.feedUrl).toBe("https://example.com/feed");
  });

  it("MEDIA_FEED_PODCAST_NO_FEED when no feed is discoverable", async () => {
    // Initial page + every well-known probe returns 404
    fetchMock.mockResolvedValueOnce(okText("<html><body>nothing here</body></html>"));
    for (let i = 0; i < 30; i += 1) fetchMock.mockResolvedValueOnce(notFound());
    await expect(
      scrapePodcastEpisodes({
        websiteUrl: "https://example.com/no-feed",
        filterMode: "latest",
        latestCount: 10,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_PODCAST_NO_FEED" });
  });

  // Hostile pages with N "rss"-labelled `<a href>` links must not fan us out
  // to N probes. The untrusted `<a>` candidate set is capped (16); trusted
  // candidates (`<link rel="alternate">`, well-known paths) are unaffected.
  it("caps untrusted <a href> candidates at 16 (hostile-fan-out guard)", async () => {
    const N = 64;
    const aHrefLinks = Array.from(
      { length: N },
      (_, i) => `<a href="/decoy-${i}/feed" title="RSS feed">RSS</a>`,
    ).join("\n");
    const hostilePage = `<html><body>${aHrefLinks}</body></html>`;

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okText(hostilePage)); // initial page
    // Subsequent fetches all 404. Exhaust enough so the order doesn't matter.
    for (let i = 0; i < 200; i += 1) fetchMock.mockResolvedValueOnce(notFound());

    await expect(
      scrapePodcastEpisodes({
        websiteUrl: "https://example.com/",
        filterMode: "latest",
        latestCount: 10,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_PODCAST_NO_FEED" });

    // Exact probe budget = 1 (initial fetch) + 15 (well-known) + 16 (untrusted cap).
    // The hostile page has no `<link rel="alternate">` so trusted only gets
    // the 15 well-known + 0 = 15 entries. So total ≤ 1 + 15 + 16 = 32.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + 15 + 16);
    // And critically not unbounded fan-out to N+1.
    expect(fetchMock.mock.calls.length).toBeLessThan(N);
  });
});

describe("scrapePodcastEpisodes — episode filtering", () => {
  it("filterMode=latest with latestCount=2 returns top 2 by publishedAt DESC", async () => {
    fetchMock.mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
      filterMode: "latest",
      latestCount: 2,
    });
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0].title).toBe("Episode 3");
    expect(result.episodes[1].title).toBe("Episode 2");
  });

  it("filterMode=date_range brackets by dateFrom/dateTo", async () => {
    fetchMock.mockResolvedValueOnce(okText(SAMPLE_RSS, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
      filterMode: "date_range",
      dateFrom: "2026-05-02",
      dateTo: "2026-05-03",
    });
    expect(result.episodes.map((e) => e.title)).toEqual(["Episode 3", "Episode 2"]);
  });
});

describe("scrapePodcastEpisodes — audio URL extraction", () => {
  it("prefers <enclosure url> over <media:content url>", async () => {
    const rss = `<?xml version="1.0"?>
<rss><channel><title>T</title>
  <item>
    <title>E</title>
    <enclosure url="https://example.com/a.mp3"/>
    <media:content url="https://example.com/b.mp3" xmlns:media="http://search.yahoo.com/mrss/"/>
    <pubDate>Mon, 01 May 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
    fetchMock.mockResolvedValueOnce(okText(rss, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
    });
    expect(result.episodes[0].mediaUrl).toBe("https://example.com/a.mp3");
  });

  it("falls back to <media:content url> when no <enclosure>", async () => {
    const rss = `<?xml version="1.0"?>
<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
  <item>
    <title>E</title>
    <media:content url="https://example.com/b.mp3"/>
    <pubDate>Mon, 01 May 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
    fetchMock.mockResolvedValueOnce(okText(rss, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
    });
    expect(result.episodes[0].mediaUrl).toBe("https://example.com/b.mp3");
  });

  it("skips items without any audio URL", async () => {
    const rss = `<?xml version="1.0"?>
<rss><channel><title>T</title>
  <item><title>No audio</title><pubDate>Mon, 01 May 2026 10:00:00 GMT</pubDate></item>
  <item><title>Has audio</title><enclosure url="https://example.com/a.mp3"/><pubDate>Mon, 02 May 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
    fetchMock.mockResolvedValueOnce(okText(rss, "application/rss+xml"));
    const result = await scrapePodcastEpisodes({
      websiteUrl: "https://example.com/feed.xml",
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].title).toBe("Has audio");
  });
});
