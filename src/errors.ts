export const MEDIA_FEED_ERROR_CODES = [
  "MEDIA_FEED_YOUTUBE_KEY_MISSING",
  "MEDIA_FEED_YOUTUBE_AUTH",
  "MEDIA_FEED_YOUTUBE_QUOTA",
  "MEDIA_FEED_YOUTUBE_FETCH",
  "MEDIA_FEED_YOUTUBE_INVALID_URL",
  "MEDIA_FEED_YOUTUBE_NO_CHANNEL",
  "MEDIA_FEED_PODCAST_INVALID_URL",
  "MEDIA_FEED_PODCAST_FETCH",
  "MEDIA_FEED_PODCAST_NO_FEED",
  "MEDIA_FEED_PODCAST_PARSE",
] as const;

export type MediaFeedErrorCode = (typeof MEDIA_FEED_ERROR_CODES)[number];

export class MediaFeedError extends Error {
  readonly code: MediaFeedErrorCode;
  constructor(code: MediaFeedErrorCode, message: string) {
    super(message);
    this.name = "MediaFeedError";
    this.code = code;
  }
}
