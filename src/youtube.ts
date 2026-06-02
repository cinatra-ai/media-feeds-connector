// Lists the uploads playlist of a YouTube channel via YouTube Data API v3.
// Auth is the existing Nango OAuth-managed access token surface
// (`@/lib/youtube-api:getConfiguredYouTubeAccessToken`), NOT a static API
// key — keeps token lifecycle (refresh, revocation) inside the connector
// platform and avoids a second secret surface.
//
// URL classification runs inside the entry function so callers cannot bypass
// it by passing a `/watch` or `/shorts` URL with an explicit `source:
// "youtube"` upstream.

import { classifyMediaFeedUrl } from "./url-classifier";
import { MediaFeedError } from "./errors";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_PAGE_LIMIT = 10;
const YOUTUBE_PAGE_SIZE = 50;

type YouTubeChannelResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      customUrl?: string;
    };
    contentDetails?: {
      relatedPlaylists?: {
        uploads?: string;
      };
    };
  }>;
  error?: { message?: string };
};

type YouTubePlaylistItemsResponse = {
  nextPageToken?: string;
  items?: Array<{
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      resourceId?: {
        videoId?: string;
      };
    };
  }>;
  error?: { message?: string };
};

export type YouTubeEpisode = {
  id: string;
  title: string;
  link: string;
  mediaUrl: string;
  description?: string;
  publishedAt?: string;
};

export type ScrapeYouTubeChannelResult = {
  channelTitle: string;
  channelUrl: string;
  episodes: YouTubeEpisode[];
};

export type YouTubeTokenProvider = () => Promise<string | null>;

function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// Stable id derived from mediaUrl + title + publishedAt; mirrors archive's
// buildTranscriptGeneratorItemId shape but is self-contained so we don't
// import the archive's store layer.
function buildEpisodeId(input: {
  mediaUrl: string;
  title: string;
  publishedAt?: string;
}): string {
  const seed = `${input.mediaUrl}|${input.title}|${input.publishedAt ?? ""}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `yt-${Math.abs(hash).toString(36)}`;
}

function getChannelLookupFromUrl(channelUrl: string): {
  mode: "forHandle" | "id" | "forUsername";
  value: string;
  canonicalUrl: string;
} {
  const parsed = new URL(channelUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.startsWith("/@")) {
    return {
      mode: "forHandle",
      value: pathname.slice(2),
      canonicalUrl: `${parsed.origin}${pathname}`,
    };
  }
  if (pathname.startsWith("/channel/")) {
    return {
      mode: "id",
      value: pathname.slice("/channel/".length),
      canonicalUrl: `${parsed.origin}${pathname}`,
    };
  }
  if (pathname.startsWith("/user/")) {
    return {
      mode: "forUsername",
      value: pathname.slice("/user/".length),
      canonicalUrl: `${parsed.origin}${pathname}`,
    };
  }
  if (pathname.startsWith("/c/")) {
    // Legacy custom URL form. The API doesn't accept /c/<slug> directly —
    // fall back to forUsername lookup mode (older accounts have it set).
    return {
      mode: "forUsername",
      value: pathname.slice("/c/".length),
      canonicalUrl: `${parsed.origin}${pathname}`,
    };
  }
  throw new MediaFeedError(
    "MEDIA_FEED_YOUTUBE_INVALID_URL",
    `URL is not a YouTube channel/handle/user URL — got "${channelUrl}". Supported: /@handle, /channel/UC..., /user/<name>, /c/<slug>.`,
  );
}

async function fetchYouTubeJSON<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  tokenProvider: YouTubeTokenProvider,
): Promise<T> {
  const accessToken = await tokenProvider();
  if (!accessToken) {
    throw new MediaFeedError(
      "MEDIA_FEED_YOUTUBE_KEY_MISSING",
      "YouTube is not connected. Configure the YouTube connector at /configuration/llm (Nango OAuth).",
    );
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && `${value}`.trim()) {
      searchParams.set(key, String(value));
    }
  }
  const response = await fetch(
    `${YOUTUBE_API_BASE}${path}?${searchParams.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      // 401 = unauthenticated/expired; 403 = forbidden, often quota.
      // YouTube returns 403 with reason "quotaExceeded" in payload — match
      // on the message text since the structured `reason` field isn't
      // promised by all error responses.
      const isQuota = /quota|rate/i.test(detail);
      throw new MediaFeedError(
        isQuota ? "MEDIA_FEED_YOUTUBE_QUOTA" : "MEDIA_FEED_YOUTUBE_AUTH",
        `YouTube API ${response.status}: ${detail}`,
      );
    }
    throw new MediaFeedError(
      "MEDIA_FEED_YOUTUBE_FETCH",
      `YouTube API ${response.status}: ${detail}`,
    );
  }
  return payload as T;
}

async function fetchChannel(
  lookup: { mode: "forHandle" | "id" | "forUsername"; value: string },
  tokenProvider: YouTubeTokenProvider,
) {
  const payload = await fetchYouTubeJSON<YouTubeChannelResponse>(
    "/channels",
    {
      part: "snippet,contentDetails",
      [lookup.mode]: lookup.value,
      maxResults: 1,
    },
    tokenProvider,
  );
  const channel = payload.items?.[0];
  const uploadsPlaylistId =
    channel?.contentDetails?.relatedPlaylists?.uploads?.trim();
  if (!channel?.id || !uploadsPlaylistId) {
    throw new MediaFeedError(
      "MEDIA_FEED_YOUTUBE_NO_CHANNEL",
      `No YouTube channel uploads playlist found for ${lookup.mode}="${lookup.value}".`,
    );
  }
  return {
    id: channel.id,
    title: channel.snippet?.title?.trim() || lookup.value,
    uploadsPlaylistId,
  };
}

// Public entry. `tokenProvider` is injected so unit tests can mock it
// without faking the Nango OAuth surface.
export async function scrapeYouTubeChannelEpisodes(
  input: { channelUrl: string },
  tokenProvider: YouTubeTokenProvider,
): Promise<ScrapeYouTubeChannelResult> {
  const channelUrl = input.channelUrl.trim();

  // Validate upfront so callers cannot bypass the classifier by passing a
  // /watch or /shorts URL.
  if (classifyMediaFeedUrl(channelUrl) !== "youtube") {
    throw new MediaFeedError(
      "MEDIA_FEED_YOUTUBE_INVALID_URL",
      `URL is not a YouTube channel listing — got "${channelUrl}". Supported: youtube.com/@handle, /channel/UC..., /user/<name>, /c/<slug>. Reject: /watch, /shorts, /playlist, youtu.be.`,
    );
  }

  const lookup = getChannelLookupFromUrl(channelUrl);
  const channel = await fetchChannel(lookup, tokenProvider);

  const episodes: YouTubeEpisode[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  while (pageCount < YOUTUBE_PAGE_LIMIT) {
    pageCount += 1;
    const payload = await fetchYouTubeJSON<YouTubePlaylistItemsResponse>(
      "/playlistItems",
      {
        part: "snippet",
        playlistId: channel.uploadsPlaylistId,
        maxResults: YOUTUBE_PAGE_SIZE,
        pageToken,
      },
      tokenProvider,
    );
    for (const item of payload.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId?.trim();
      const title = item.snippet?.title?.trim() || "Untitled video";
      if (!videoId || title === "Private video" || title === "Deleted video") {
        continue;
      }
      const publishedAt = normalizeDate(item.snippet?.publishedAt);
      const link = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      episodes.push({
        id: buildEpisodeId({ mediaUrl: link, title, publishedAt }),
        title,
        link,
        mediaUrl: link,
        description: item.snippet?.description?.trim() || undefined,
        publishedAt,
      });
    }
    pageToken = payload.nextPageToken?.trim() || undefined;
    if (!pageToken) break;
  }

  return {
    channelTitle: channel.title,
    channelUrl: lookup.canonicalUrl,
    episodes,
  };
}
