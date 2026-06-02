// Discovers an RSS/Atom feed from a podcast website URL and parses
// episodes using deterministic discovery heuristics:
//   1. Direct .xml/.rss URL → use as-is.
//   2. Fetch the page, look for <link rel="alternate"> + <link type="rss">
//      + textual feed/podcast hints.
//   3. Probe 14 well-known feed paths.
//
// SSRF guards: only http/https; reject the blocked private CIDR ranges before
// the fetch happens, mirroring the URL validation defense used by the LLM bridge.
// We duplicate the host-allowlist logic locally rather than importing the
// bridge module, because the bridge module is host-only and this connector
// must remain Node-importable without bringing in Next.js server-only refs.

import { load } from "cheerio";
import { isIP } from "node:net";
import { MediaFeedError } from "./errors";

// Emit `mediaUrl` directly from the primitive instead of asking the LLM to
// rename `audioUrl → mediaUrl` post-call. Any run that emitted the raw
// primitive shape would null-dereference downstream in
// @cinatra-ai/media-transcript-agent, which expects `mediaUrl`.
type ScrapedEpisode = {
  id: string;
  title: string;
  link?: string;
  mediaUrl: string;
  description?: string;
  publishedAt?: string;
  duration?: string;
};

export type ScrapePodcastEpisodesInput = {
  websiteUrl: string;
  filterMode?: "date_range" | "latest";
  dateFrom?: string;
  dateTo?: string;
  latestCount?: number;
};

export type ScrapePodcastEpisodesResult = {
  podcastTitle: string;
  websiteUrl: string;
  feedUrl: string;
  episodes: ScrapedEpisode[];
};

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "Cinatra Media Feed Lister/0.1";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.aws",
  "metadata.azure.com",
]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function stripBrackets(host: string): string {
  // Node's URL.hostname returns "[::1]" (WITH brackets) for IPv6 literals,
  // and isIP("[::1]") returns 0 — bracket strip is mandatory before isIP.
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isSafeHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (BLOCKED_HOSTS.has(lower)) return false;
  const stripped = stripBrackets(host);
  const family = isIP(stripped);
  if (family === 4) return !isPrivateIpv4(stripped);
  if (family === 6) return false; // conservative — block all IPv6 literals
  return true;
}

function ensureSafeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      `Cannot parse URL: ${rawUrl}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      `Scheme ${parsed.protocol} not allowed (http/https only).`,
    );
  }
  if (!isSafeHost(parsed.hostname)) {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      `Hostname ${parsed.hostname} is blocked.`,
    );
  }
  return parsed;
}

function buildPodcastEpisodeId(input: {
  mediaUrl: string;
  title: string;
  publishedAt?: string;
}): string {
  const seed = `${input.mediaUrl}|${input.title}|${input.publishedAt ?? ""}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `pod-${Math.abs(hash).toString(36)}`;
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function looksLikeFeed(xml: string): boolean {
  return /<(rss|feed|channel)\b/i.test(xml);
}

async function fetchText(url: string): Promise<string> {
  // Validate every fetch hop, not just the seed — defense against
  // 302-to-private redirects. Node's global fetch follows redirects by
  // default; the safe pattern is `redirect: "manual"` with per-hop
  // validation. Cap byte count to FETCH_MAX_BYTES and timeout via
  // AbortController.
  let current = ensureSafeUrl(url).toString();
  for (let hop = 0; hop < 4; hop += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xml,text/xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.8",
        },
        cache: "no-store",
        redirect: "manual",
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new MediaFeedError(
          "MEDIA_FEED_PODCAST_FETCH",
          `Redirect from ${current} had no Location header.`,
        );
      }
      current = ensureSafeUrl(new URL(location, current).toString()).toString();
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!response.ok) {
      throw new MediaFeedError(
        "MEDIA_FEED_PODCAST_FETCH",
        `Unable to fetch ${current} (HTTP ${response.status}).`,
      );
    }
    // Stream-read with byte cap.
    const reader = response.body?.getReader();
    if (!reader) return await response.text();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > FETCH_MAX_BYTES) {
          await reader.cancel("size-exceeded").catch(() => {});
          throw new MediaFeedError(
            "MEDIA_FEED_PODCAST_FETCH",
            `Response from ${current} exceeded ${FETCH_MAX_BYTES} bytes.`,
          );
        }
        chunks.push(value);
      }
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  }
  throw new MediaFeedError(
    "MEDIA_FEED_PODCAST_FETCH",
    `Exceeded redirect cap while resolving ${url}.`,
  );
}

// Cap the number of untrusted `<a href>` candidates a hostile site can fan us
// out across. A page with N hand-crafted "rss"-themed links would otherwise
// force N probes each with a 10s fetch budget. Trusted sources (direct URL
// hint, `<link rel="alternate">`, well-known paths) are not capped; only the
// unbounded `<a>` selector is.
const UNTRUSTED_A_HREF_CANDIDATE_CAP = 16;

async function discoverFeedUrl(websiteUrl: string): Promise<{ feedUrl: string; xml: string }> {
  const html = await fetchText(websiteUrl);
  if (looksLikeFeed(html)) {
    return { feedUrl: websiteUrl, xml: html };
  }

  // Trusted candidates: emit-once, deterministic, structural.
  const trusted = new Set<string>();
  if (websiteUrl.match(/\.(xml|rss)$/i)) trusted.add(websiteUrl);

  const $ = load(html);
  // `<link rel="alternate">` is the canonical machine-readable feed pointer.
  $("link[href]").each((_, element) => {
    const href = String($(element).attr("href") ?? "").trim();
    const type = String($(element).attr("type") ?? "").toLowerCase();
    const rel = String($(element).attr("rel") ?? "").toLowerCase();
    if (!href) return;
    if (
      type.includes("rss") ||
      type.includes("atom") ||
      rel.includes("alternate") ||
      href.endsWith(".xml") ||
      href.includes("/feed") ||
      href.includes("rss") ||
      href.includes("podcast")
    ) {
      const resolved = resolveUrl(href, websiteUrl);
      if (resolved) trusted.add(resolved);
    }
  });

  const wellKnown = [
    "/feed",
    "/rss",
    "/rss.xml",
    "/feed.xml",
    "/podcast.xml",
    "/podcast/feed",
    "/podcast/rss",
    "/podcast/rss.xml",
    "/podcast/feed.xml",
    "/podcasts/feed",
    "/podcasts/rss",
    "/podcasts/rss.xml",
    "/episodes/feed",
    "/episodes/rss",
    "/feed/podcast",
  ];
  for (const path of wellKnown) {
    const resolved = resolveUrl(path, websiteUrl);
    if (resolved) trusted.add(resolved);
  }

  // Untrusted candidates: `<a href>` is unbounded user-content, easy to abuse.
  // Dedupe against the trusted set then cap at UNTRUSTED_A_HREF_CANDIDATE_CAP.
  const untrusted: string[] = [];
  const untrustedSeen = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = String($(element).attr("href") ?? "").trim();
    const type = String($(element).attr("type") ?? "").toLowerCase();
    const rel = String($(element).attr("rel") ?? "").toLowerCase();
    const title = String($(element).attr("title") ?? "").toLowerCase();
    const ariaLabel = String($(element).attr("aria-label") ?? "").toLowerCase();
    const text = $(element).text().trim().toLowerCase();
    if (!href) return;
    if (
      type.includes("rss") ||
      type.includes("atom") ||
      rel.includes("alternate") ||
      href.endsWith(".xml") ||
      href.includes("/feed") ||
      href.includes("rss") ||
      href.includes("podcast") ||
      text.includes("rss") ||
      text.includes("feed") ||
      text.includes("podcast") ||
      title.includes("rss") ||
      title.includes("feed") ||
      title.includes("podcast") ||
      ariaLabel.includes("rss") ||
      ariaLabel.includes("feed") ||
      ariaLabel.includes("podcast")
    ) {
      const resolved = resolveUrl(href, websiteUrl);
      if (!resolved) return;
      if (trusted.has(resolved) || untrustedSeen.has(resolved)) return;
      if (untrusted.length >= UNTRUSTED_A_HREF_CANDIDATE_CAP) return;
      untrustedSeen.add(resolved);
      untrusted.push(resolved);
    }
  });

  // Probe trusted first, then capped-untrusted.
  for (const candidate of [...trusted, ...untrusted]) {
    try {
      const xml = await fetchText(candidate);
      if (looksLikeFeed(xml)) {
        return { feedUrl: candidate, xml };
      }
    } catch {
      continue;
    }
  }
  throw new MediaFeedError(
    "MEDIA_FEED_PODCAST_NO_FEED",
    `Unable to discover a podcast feed from ${websiteUrl}. Try the direct RSS/feed URL instead.`,
  );
}

function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function matchesDateRange(
  publishedAt: string | undefined,
  dateFrom?: string,
  dateTo?: string,
): boolean {
  if (!publishedAt) return true;
  const published = new Date(publishedAt).getTime();
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00`).getTime();
    if (published < from) return false;
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999`).getTime();
    if (published > to) return false;
  }
  return true;
}

export async function scrapePodcastEpisodes(
  input: ScrapePodcastEpisodesInput,
): Promise<ScrapePodcastEpisodesResult> {
  const websiteUrl = input.websiteUrl.trim();
  if (!websiteUrl) {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      "Provide a podcast website URL.",
    );
  }

  const { feedUrl, xml } = await discoverFeedUrl(websiteUrl);
  let $: ReturnType<typeof load>;
  try {
    $ = load(xml, { xmlMode: true });
  } catch (err) {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_PARSE",
      `Failed to parse feed XML from ${feedUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const podcastTitle =
    $("channel > title").first().text().trim() ||
    $("feed > title").first().text().trim() ||
    $("title").first().text().trim() ||
    "Podcast";
  const rawItems = $("item").toArray();
  const items = rawItems.length > 0 ? rawItems : $("entry").toArray();
  const rawEpisodes: Array<ScrapedEpisode | null> = items.map((item) => {
    const node = $(item);
    const title =
      node.find("title").first().text().trim() ||
      node.find("itunes\\:title").first().text().trim() ||
      "Untitled episode";
    const enclosureUrl = node.find("enclosure").attr("url")?.trim() || "";
    const mediaContentUrl = node.find("media\\:content").attr("url")?.trim() || "";
    const mediaUrl = enclosureUrl || mediaContentUrl;
    const link =
      node.find("link").first().text().trim() ||
      node.find("link[rel='alternate']").attr("href")?.trim() ||
      undefined;
    const description =
      node.find("description").first().text().trim() ||
      node.find("content").first().text().trim() ||
      node.find("itunes\\:summary").first().text().trim() ||
      undefined;
    const publishedAt = normalizeDate(
      node.find("pubDate").first().text().trim() ||
        node.find("published").first().text().trim() ||
        node.find("updated").first().text().trim(),
    );
    const duration =
      node.find("itunes\\:duration").first().text().trim() ||
      node.find("duration").first().text().trim() ||
      undefined;
    if (!mediaUrl) return null;
    return {
      id: buildPodcastEpisodeId({ mediaUrl, title, publishedAt }),
      title,
      link,
      mediaUrl,
      description,
      publishedAt,
      duration,
    } satisfies ScrapedEpisode;
  });

  const matchingEpisodes: ScrapedEpisode[] = rawEpisodes
    .filter((e): e is ScrapedEpisode => e !== null)
    .filter((e) => matchesDateRange(e.publishedAt, input.dateFrom, input.dateTo))
    .sort((l, r) =>
      String(r.publishedAt ?? "").localeCompare(String(l.publishedAt ?? "")),
    );

  const filterMode = input.filterMode === "latest" ? "latest" : "date_range";
  const latestCount = Math.max(1, Math.min(50, Math.floor(Number(input.latestCount) || 10)));
  const episodes =
    filterMode === "latest" ? matchingEpisodes.slice(0, latestCount) : matchingEpisodes;

  return { podcastTitle, websiteUrl, feedUrl, episodes };
}
