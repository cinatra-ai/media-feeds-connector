import { z } from "zod";

export const youtubeListSchema = z.object({
  channelUrl: z.string().min(1),
});

export const podcastListSchema = z.object({
  websiteUrl: z.string().min(1),
  filterMode: z.enum(["latest", "date_range"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  latestCount: z.number().int().min(1).max(50).optional(),
});

export type YouTubeListInput = z.infer<typeof youtubeListSchema>;
export type PodcastListInput = z.infer<typeof podcastListSchema>;
