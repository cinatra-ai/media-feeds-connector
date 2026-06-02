// URL classification helper.
//
// Classifies a URL as a media-feed listing source. Uses URL.host allowlist
// + path-prefix check (no regex on the full string).
//
// Rejected as YouTube: /watch, /shorts, /playlist, /embed, and any
// youtu.be URL — those are individual video URLs, not channel/listing URLs.
// The intent of media-feed-lister is to enumerate uploads from a channel,
// so those subpaths cannot be processed by the YouTube Data API
// /playlistItems endpoint anyway.

export type MediaFeedClassification = "youtube" | "podcast" | "unsupported";

const YOUTUBE_HOST_ALLOWLIST = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const YOUTUBE_CHANNEL_PATH_PREFIXES: readonly string[] = [
  "/@",
  "/channel/",
  "/user/",
  "/c/",
];

export function classifyMediaFeedUrl(rawUrl: string): MediaFeedClassification {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "unsupported";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "unsupported";
  }
  const host = parsed.hostname.toLowerCase();
  if (YOUTUBE_HOST_ALLOWLIST.has(host)) {
    // Strict allowlist — anything that isn't an explicit channel path is NOT
    // a listing source. Rejects /watch, /shorts, /playlist, /embed,
    // /results, /feed/trending, /, etc.
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    if (YOUTUBE_CHANNEL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return "youtube";
    }
    return "unsupported";
  }
  if (host === "youtu.be") {
    // youtu.be is the short-link domain for INDIVIDUAL videos; never a
    // channel listing input.
    return "unsupported";
  }
  // Anything else with a valid http(s) URL is treated as a podcast website
  // candidate; RSS discovery decides if it's a real feed.
  return "podcast";
}
