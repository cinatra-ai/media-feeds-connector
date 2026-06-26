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
import { lookup as dnsLookup } from "node:dns/promises";
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

// Expand a (possibly compressed, possibly dotted-suffixed) IPv6 string into
// its 8 numeric hextets. Returns null if it cannot be parsed as 8 groups —
// callers must fail closed on null.
function expandIpv6Hextets(lower: string): number[] | null {
  // Convert a trailing dotted-quad (::ffff:1.2.3.4) into two hex hextets so
  // the whole address is uniform hex before splitting.
  let work = lower;
  const dotted = work.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(1).map((d) => Number(d));
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0] as number) << 8) | (o[1] as number);
    const lo = ((o[2] as number) << 8) | (o[3] as number);
    work =
      work.slice(0, dotted.index) +
      hi.toString(16) +
      ":" +
      lo.toString(16);
  }

  const halves = work.split("::");
  if (halves.length > 2) return null;
  const parsePart = (p: string): number[] | null => {
    if (p === "") return [];
    const groups = p.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parsePart(halves[0] as string);
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = parsePart(halves[1] as string);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

// If `lower` is an IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96, but
// not :: or ::1 themselves) address, return the embedded IPv4 in dotted form;
// otherwise null.
function extractEmbeddedIpv4(lower: string): string | null {
  const h = expandIpv6Hextets(lower);
  if (h === null) return null;
  const allZeroPrefix6 = h.slice(0, 6).every((x) => x === 0);
  const v4Mapped = h[4] === 0 && h[5] === 0xffff && h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0;
  const v4Compat = allZeroPrefix6 && !(h[6] === 0 && h[7] === 0) && !(h[6] === 0 && h[7] === 1);
  if (!v4Mapped && !v4Compat) return null;
  const a = ((h[6] as number) >> 8) & 0xff;
  const b = (h[6] as number) & 0xff;
  const c = ((h[7] as number) >> 8) & 0xff;
  const d = (h[7] as number) & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

// Block IPv6 addresses that are loopback, unspecified, ULA, link-local,
// multicast, or IPv4-mapped onto an unsafe IPv4. `addr` must be a canonical
// IPv6 string (from URL.hostname-stripped literals or dns.lookup output);
// we normalize through net's family detection rather than trusting prefixes.
function isPrivateIpv6(addr: string): boolean {
  if (isIP(addr) !== 6) return true; // not a valid v6 literal → fail closed
  const lower = addr.toLowerCase();

  // Classify loopback (::1) and unspecified (::) from the EXPANDED hextets, not
  // a string match: a non-canonical equivalent (`0:0:0:0:0:0:0:1`, `0::1`,
  // `::0.0.0.1`) is still loopback and must be blocked. A security predicate
  // must not depend on URL/DNS upstream canonicalization it does not control —
  // `dns.lookup` output is not guaranteed canonical. Fail closed if we cannot
  // expand the address.
  const hextets = expandIpv6Hextets(lower);
  if (hextets === null) return true;
  const allZero = hextets.every((x) => x === 0);
  if (allZero) return true; // :: (unspecified)
  if (hextets.slice(0, 7).every((x) => x === 0) && hextets[7] === 1) return true; // ::1 (loopback)

  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:HHHH:HHHH) and the deprecated
  // IPv4-compatible (::a.b.c.d) forms embed an IPv4 address — extract the
  // embedded v4 and apply the v4 blocklist. The embedded address can appear
  // in EITHER dotted-quad form OR hex-hextet form (e.g. ::ffff:a9fe:a9fe is
  // 169.254.169.254), so we must handle both — a trailing-dotted-quad regex
  // alone is bypassable. We expand the address fully, then if it lies in the
  // v4-mapped (::ffff:0:0/96) or v4-compatible (::/96) space, rebuild the
  // dotted IPv4 from the final 32 bits.
  const embeddedV4 = extractEmbeddedIpv4(lower);
  if (embeddedV4 !== null) {
    return isPrivateIpv4(embeddedV4);
  }

  const firstHextet = lower.split(":")[0] ?? "";
  const head = parseInt(firstHextet || "0", 16);
  if (Number.isNaN(head)) return true; // fail closed
  // fc00::/7  (Unique Local Addresses) → first 7 bits are 1111 110
  if ((head & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local) → first 10 bits are 1111 1110 10
  if ((head & 0xffc0) === 0xfe80) return true;
  // ff00::/8  (multicast)
  if ((head & 0xff00) === 0xff00) return true;
  return false;
}

// Classify a literal IP string (already bracket-stripped). Returns true when
// the address is safe to connect to. Fail closed on anything unrecognized.
function isSafeIpLiteral(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isPrivateIpv4(ip);
  if (family === 6) return !isPrivateIpv6(ip);
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

// Resolve a DNS hostname and assert EVERY resolved address is safe before any
// socket is opened. This closes the gap where isSafeHost() returned true for
// any DNS name regardless of where it pointed (e.g. a name resolving to
// 169.254.169.254 / 10.x / fe80::). Fail closed on resolution failure, zero
// answers, or ANY unsafe answer (mixed safe/unsafe → reject).
//
// Residual: a narrow DNS-rebinding TOCTOU remains between this lookup and the
// lookup Node's global fetch performs when it opens the socket — fully closing
// it requires a transport/dispatcher connect hook (undici), which is
// intentionally out of scope here (no new dependency). For a Medium-severity
// SSRF this resolve-and-validate control removes the primary exposure.
async function assertHostResolvesSafe(host: string): Promise<void> {
  const stripped = stripBrackets(host);
  // IP literals were already validated by isSafeHost; no DNS needed.
  if (isIP(stripped) !== 0) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(stripped, { all: true, verbatim: true });
  } catch {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      `Hostname ${host} could not be resolved.`,
    );
  }
  if (addresses.length === 0) {
    throw new MediaFeedError(
      "MEDIA_FEED_PODCAST_INVALID_URL",
      `Hostname ${host} resolved to no addresses.`,
    );
  }
  for (const { address } of addresses) {
    if (!isSafeIpLiteral(address)) {
      throw new MediaFeedError(
        "MEDIA_FEED_PODCAST_INVALID_URL",
        `Hostname ${host} resolves to a blocked address.`,
      );
    }
  }
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

// String-level fast-fail (ensureSafeUrl) PLUS DNS resolution + per-address
// validation. This is the guard that must run before every actual fetch and
// before following every redirect hop.
async function ensureSafeUrlResolved(rawUrl: string): Promise<URL> {
  const parsed = ensureSafeUrl(rawUrl);
  await assertHostResolvesSafe(parsed.hostname);
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
  let current = (await ensureSafeUrlResolved(url)).toString();
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
      current = (
        await ensureSafeUrlResolved(new URL(location, current).toString())
      ).toString();
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
