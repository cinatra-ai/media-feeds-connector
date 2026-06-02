import "server-only";

import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";
import { createMediaFeedsPrimitiveHandlers } from "./handlers";
import { youtubeListSchema, podcastListSchema } from "./schemas";

// The two `media_feed_*` handlers read only `request.input` (they fetch public
// YouTube/podcast data via the input URL + the ambient connector token); they do
// NOT consume `request.actor`. Authorization is enforced upstream at the MCP
// boundary (kernel; inventory-augment marks both primitives `status:"enforced"`),
// so a static model actor is passed and the host `mcpRequestContextStorage` read
// is dropped — keeping the connector off `@cinatra-ai/mcp-server`.
const STATIC_AGENT_ACTOR = { actorType: "model", source: "agent" } as const;

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "media_feed_youtube_list": {
    description:
      "List uploads from a YouTube channel via YouTube Data API v3. Accepts youtube.com/@handle, /channel/UC..., /user/<name>, or /c/<slug> URLs. Rejects /watch, /shorts, /playlist, and youtu.be (video URLs, not channel listings). Requires the YouTube connector to be connected via Nango at /configuration/llm. Returns { channelTitle, channelUrl, episodes: [{ id, title, link, mediaUrl, description?, publishedAt? }] }.",
    inputSchema: youtubeListSchema,
  },
  "media_feed_podcast_list": {
    description:
      "List episodes from a podcast website by discovering its RSS/Atom feed. Probes <link rel='alternate'> + 14 well-known feed paths. Supports filterMode='latest' (top N by publishedAt DESC) or filterMode='date_range' (bracket by dateFrom/dateTo). Returns { podcastTitle, websiteUrl, feedUrl, episodes: [{ id, title, link?, mediaUrl, description?, publishedAt?, duration? }] }.",
    inputSchema: podcastListSchema,
  },
};

export function registerMediaFeedsPrimitives(server: ExtensionMcpToolServer) {
  const handlers = createMediaFeedsPrimitiveHandlers();
  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      async (input: unknown): Promise<ExtensionMcpToolResult> => {
        const result = await handler({
          primitiveName: name,
          input,
          actor: STATIC_AGENT_ACTOR,
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent:
            Array.isArray(result)
              ? { items: result }
              : typeof result === "object" && result !== null
                ? (result as Record<string, unknown>)
                : { result },
        };
      },
    );
  }
}
