import "server-only";

import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
import { getConfiguredYouTubeAccessToken } from "@/lib/youtube-api";
import { scrapeYouTubeChannelEpisodes } from "../youtube";
import { scrapePodcastEpisodes } from "../feed";
import { youtubeListSchema, podcastListSchema } from "./schemas";

export function createMediaFeedsPrimitiveHandlers() {
  return {
    "media_feed_youtube_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = youtubeListSchema.parse(request.input);
      return scrapeYouTubeChannelEpisodes(input, getConfiguredYouTubeAccessToken);
    },
    "media_feed_podcast_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = podcastListSchema.parse(request.input);
      return scrapePodcastEpisodes(input);
    },
  };
}

export type MediaFeedsPrimitiveHandlers = ReturnType<typeof createMediaFeedsPrimitiveHandlers>;
