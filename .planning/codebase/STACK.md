# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript — all source and test files under `src/`

**Secondary:**
- Not applicable

## Runtime

**Environment:**
- Node.js (ESM module system; `"type": "module"` in `package.json`)
- Target: ES2023 (`tsconfig.json` `target`)

**Package Manager:**
- npm (`.npmrc` present)
- Lockfile: not present in repo root (likely managed by a monorepo parent)

## Frameworks

**Core:**
- None (plain TypeScript library — no web framework)

**Testing:**
- Vitest — config at `vitest.config.ts`, test environment: `node`

**Build/Dev:**
- TypeScript compiler (`tsc`) — outputs to `dist/`, declarations + source maps enabled (`tsconfig.json`)

## Key Dependencies

**Critical:**
- `cheerio` ^1.2.0 — HTML/XML parsing for podcast feed discovery and RSS/Atom episode extraction (`src/feed.ts`)
- `zod` ^4.3.6 — runtime input validation for MCP tool schemas (`src/mcp/schemas.ts`)
- `server-only` ^0.0.1 — Next.js guard; imported in `src/mcp/module.ts` and `src/mcp/handlers.ts` to prevent client-side bundle inclusion

**Peer (optional):**
- `@cinatra-ai/sdk-extensions` — provides `ExtensionPrimitiveRequest` type consumed by `src/mcp/handlers.ts`; optional peer dependency, must be satisfied by the host application

## Configuration

**Environment:**
- No `.env` file present in this package; environment variables are injected by the host application (YouTube OAuth token is retrieved via `@/lib/youtube-api:getConfiguredYouTubeAccessToken` at runtime)
- `vitest.config.ts` aliases `server-only` to a stub and `@/` to the monorepo root `src/` for tests

**Build:**
- `tsconfig.json` — strict mode, `moduleResolution: bundler`, `isolatedModules: true`, `verbatimModuleSyntax: true`, outputs declarations + source maps to `dist/`

## Platform Requirements

**Development:**
- Node.js with native `fetch`, `AbortController`, `node:net` (`isIP`) support (Node 18+)
- Must be built/tested from within the monorepo (vitest config references `../../..` as repo root for stubs and `@/` alias)

**Production:**
- Deployed as a Next.js server-side module (enforced by `server-only` import guard)
- YouTube API calls use OAuth access tokens managed via Nango; no static API keys in this package

---

*Stack analysis: 2026-06-09*
