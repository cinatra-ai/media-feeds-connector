import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaFeedError } from "../errors";
import { scrapeYouTubeChannelEpisodes } from "../youtube";

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function ok<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("scrapeYouTubeChannelEpisodes — auth + error mapping", () => {
  it("MEDIA_FEED_YOUTUBE_KEY_MISSING when token provider returns null", async () => {
    await expect(
      scrapeYouTubeChannelEpisodes(
        { channelUrl: "https://youtube.com/@example" },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_KEY_MISSING" });
  });

  it("MEDIA_FEED_YOUTUBE_AUTH on 401", async () => {
    fetchMock.mockResolvedValueOnce(err(401, "Invalid Credentials"));
    await expect(
      scrapeYouTubeChannelEpisodes(
        { channelUrl: "https://youtube.com/@example" },
        async () => "token",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_AUTH" });
  });

  it("MEDIA_FEED_YOUTUBE_QUOTA on 403 with quota message", async () => {
    fetchMock.mockResolvedValueOnce(err(403, "The request cannot be completed because you have exceeded your quota."));
    await expect(
      scrapeYouTubeChannelEpisodes(
        { channelUrl: "https://youtube.com/@example" },
        async () => "token",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_QUOTA" });
  });

  it("MEDIA_FEED_YOUTUBE_FETCH on 500", async () => {
    fetchMock.mockResolvedValueOnce(err(500, "internal"));
    await expect(
      scrapeYouTubeChannelEpisodes(
        { channelUrl: "https://youtube.com/@example" },
        async () => "token",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_FETCH" });
  });
});

describe("scrapeYouTubeChannelEpisodes — URL classification", () => {
  it.each([
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/playlist?list=PL123",
    "https://youtu.be/abc",
  ])("rejects non-channel YouTube URL %s before any fetch", async (rawUrl) => {
    await expect(
      scrapeYouTubeChannelEpisodes({ channelUrl: rawUrl }, async () => "token"),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_INVALID_URL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("scrapeYouTubeChannelEpisodes — happy path", () => {
  it("paginates through playlistItems and returns episodes", async () => {
    fetchMock
      // /channels lookup
      .mockResolvedValueOnce(
        ok({
          items: [
            {
              id: "UCabc",
              snippet: { title: "Lex Fridman" },
              contentDetails: { relatedPlaylists: { uploads: "UUabc" } },
            },
          ],
        }),
      )
      // page 1 of /playlistItems
      .mockResolvedValueOnce(
        ok({
          nextPageToken: "TOKEN2",
          items: [
            {
              snippet: {
                title: "#456 Guest Name",
                resourceId: { videoId: "vid1" },
                publishedAt: "2026-05-01T00:00:00Z",
                description: "Episode 456",
              },
            },
            {
              snippet: {
                title: "Private video",
                resourceId: { videoId: "vid2" },
                publishedAt: "2026-04-30T00:00:00Z",
              },
            },
          ],
        }),
      )
      // page 2 — no next token
      .mockResolvedValueOnce(
        ok({
          items: [
            {
              snippet: {
                title: "#455 Earlier Guest",
                resourceId: { videoId: "vid3" },
                publishedAt: "2026-04-01T00:00:00Z",
              },
            },
          ],
        }),
      );

    const result = await scrapeYouTubeChannelEpisodes(
      { channelUrl: "https://www.youtube.com/@lexfridman" },
      async () => "token",
    );
    expect(result.channelTitle).toBe("Lex Fridman");
    expect(result.channelUrl).toBe("https://www.youtube.com/@lexfridman");
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0].mediaUrl).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
    expect(result.episodes[0].publishedAt).toBe("2026-05-01T00:00:00.000Z");
    // "Private video" was skipped
    expect(result.episodes.some((e) => e.title === "Private video")).toBe(false);
  });

  it("caps pagination at 10 pages even if nextPageToken keeps coming", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        items: [
          {
            id: "UCabc",
            snippet: { title: "Test" },
            contentDetails: { relatedPlaylists: { uploads: "UUabc" } },
          },
        ],
      }),
    );
    // 10 successive pages each returning a nextPageToken
    for (let i = 0; i < 10; i += 1) {
      fetchMock.mockResolvedValueOnce(
        ok({
          nextPageToken: `t${i + 1}`,
          items: [
            {
              snippet: {
                title: `Video ${i}`,
                resourceId: { videoId: `vid${i}` },
              },
            },
          ],
        }),
      );
    }
    const result = await scrapeYouTubeChannelEpisodes(
      { channelUrl: "https://www.youtube.com/@test" },
      async () => "token",
    );
    expect(result.episodes).toHaveLength(10);
    // 1 channel + 10 playlistItems pages = 11 fetches total
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("returns empty episodes (not error) when channel has no uploads", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({
          items: [
            {
              id: "UCabc",
              snippet: { title: "Empty Channel" },
              contentDetails: { relatedPlaylists: { uploads: "UUabc" } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(ok({ items: [] }));
    const result = await scrapeYouTubeChannelEpisodes(
      { channelUrl: "https://www.youtube.com/@empty" },
      async () => "token",
    );
    expect(result.episodes).toEqual([]);
  });

  it("MEDIA_FEED_YOUTUBE_NO_CHANNEL when API returns no items", async () => {
    fetchMock.mockResolvedValueOnce(ok({ items: [] }));
    await expect(
      scrapeYouTubeChannelEpisodes(
        { channelUrl: "https://www.youtube.com/@nonexistent" },
        async () => "token",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_FEED_YOUTUBE_NO_CHANNEL" });
  });
});

describe("MediaFeedError class", () => {
  it("preserves the code field", () => {
    const e = new MediaFeedError("MEDIA_FEED_YOUTUBE_QUOTA", "msg");
    expect(e.code).toBe("MEDIA_FEED_YOUTUBE_QUOTA");
    expect(e instanceof Error).toBe(true);
  });
});
