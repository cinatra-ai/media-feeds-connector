import "server-only";

import { registerMediaFeedsPrimitives } from "./registry";

export function createMediaFeedsModule() {
  return {
    registerCapabilities: registerMediaFeedsPrimitives,
  };
}
