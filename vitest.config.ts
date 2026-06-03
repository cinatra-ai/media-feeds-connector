import { defineConfig } from "vitest/config";
import * as path from "node:path";

const repoRoot = path.join(__dirname, "../../..");
const serverOnlyStub = path.join(repoRoot, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      // @/ → repo-root src (matches youtube-api wrapper path used by handler).
      { find: /^@\/(.+)$/, replacement: path.join(repoRoot, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
