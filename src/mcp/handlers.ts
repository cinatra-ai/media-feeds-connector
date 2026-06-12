import "server-only";

import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// hostInternal pinned-empty sweep (cinatra#172 Stage H4): the YouTube OAuth
// token mint resolves the host-bound deps slot (bound at serverEntry
// activation by `register(ctx)` adapting `@cinatra-ai/host:youtube-connection`)
// instead of importing `@/lib/youtube-api`. The MINT FUNCTION is passed into
// the scraper unchanged — same null/throw semantics, same in-process-only
// bearer posture (see the deps-slot TRUST note).
import { getMediaFeedsDeps } from "../deps";
import { scrapeYouTubeChannelEpisodes } from "../youtube";
import { scrapePodcastEpisodes } from "../feed";
import { youtubeListSchema, podcastListSchema } from "./schemas";

export function createMediaFeedsPrimitiveHandlers() {
  return {
    "media_feed_youtube_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = youtubeListSchema.parse(request.input);
      return scrapeYouTubeChannelEpisodes(
        input,
        () => getMediaFeedsDeps().getConfiguredYouTubeAccessToken(),
      );
    },
    "media_feed_podcast_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = podcastListSchema.parse(request.input);
      return scrapePodcastEpisodes(input);
    },
  };
}

export type MediaFeedsPrimitiveHandlers = ReturnType<typeof createMediaFeedsPrimitiveHandlers>;
