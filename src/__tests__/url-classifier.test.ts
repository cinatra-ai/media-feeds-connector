import { describe, expect, it } from "vitest";

import { classifyMediaFeedUrl } from "../url-classifier";

describe("classifyMediaFeedUrl — YouTube acceptance", () => {
  it.each([
    "https://youtube.com/@lexfridman",
    "https://www.youtube.com/@LexFridman",
    "https://m.youtube.com/@LexFridman",
    "https://music.youtube.com/@LexFridman",
    "https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA",
    "https://www.youtube.com/user/lexfridman",
    "https://www.youtube.com/c/LexFridman",
  ])("accepts channel-style URL %s", (rawUrl) => {
    expect(classifyMediaFeedUrl(rawUrl)).toBe("youtube");
  });
});

describe("classifyMediaFeedUrl — YouTube rejection", () => {
  it.each([
    "https://www.youtube.com/watch?v=abc123",
    "https://www.youtube.com/shorts/abc123",
    "https://www.youtube.com/playlist?list=PLabc",
    "https://www.youtube.com/embed/abc",
    "https://www.youtube.com/results?search_query=foo",
    "https://www.youtube.com/feed/trending",
    "https://www.youtube.com/",
    "https://youtu.be/abc123",
  ])("rejects non-channel YouTube URL %s", (rawUrl) => {
    expect(classifyMediaFeedUrl(rawUrl)).toBe("unsupported");
  });
});

describe("classifyMediaFeedUrl — podcast inference", () => {
  it.each([
    "https://lexfridman.com/podcast/",
    "https://www.npr.org/podcasts/foo",
    "https://example.com/blog/feed.xml",
    "https://example.com/",
    "http://podcast.example.com/show",
  ])("treats non-YouTube valid http(s) URL %s as podcast", (rawUrl) => {
    expect(classifyMediaFeedUrl(rawUrl)).toBe("podcast");
  });
});

describe("classifyMediaFeedUrl — invalid input", () => {
  it.each([
    "not a url",
    "",
    "file:///etc/passwd",
    "data:text/plain,foo",
    "ftp://example.com/foo",
    "javascript:alert(1)",
  ])("rejects invalid scheme/format %s", (rawUrl) => {
    expect(classifyMediaFeedUrl(rawUrl)).toBe("unsupported");
  });
});
