# Cliqwise

**MCP-first AI video clipping.** An AI agent (or a person) submits a long video; Cliqwise finds the best moments, captions them, and returns scored, vertical MP4 clips.

Live app: [clipwise.replit.app](https://clipwise.replit.app)

## Why this exists

Clipping long-form video is repetitive work that agents should be able to do. Most clipping tools are web-only. Cliqwise exposes the whole pipeline as an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, or any MCP client can hand it a video and get clips back.

## How it works

1. **Submit** a direct video URL, a public YouTube link, or an uploaded file (up to 3 hours / 4 GiB).
2. **Transcribe** locally with faster-whisper (multilingual base model, word-level timestamps). Audio never leaves the server.
3. **Score** candidate moments with an LLM; each clip keeps its component scores and reasoning.
4. **Render** 1-10 vertical clips with FFmpeg (center-crop framing, burned-in captions in `bold`, `minimal`, or `karaoke` style).
5. **Retrieve** results through the MCP `get_job` tool or the web app. Output links are signed and expire after one hour.

## MCP interface

Streamable HTTP endpoint at `/api/mcp`, authenticated with a bearer API key (hashed at rest, shown once). Exactly two tools:

| Tool | Purpose |
|---|---|
| `submit_video` | Submit a video URL or an uploaded `object_path` for clipping |
| `get_job` | Check job status and fetch finished clips |

Large files are not sent through MCP. Request an upload ticket at `POST /api/storage/uploads/request-url`, `PUT` the file to the returned URL, then pass the `objectPath` to `submit_video`.

## Architecture

pnpm monorepo, TypeScript throughout:

```
artifacts/
  api-server/      Express API, MCP server, durable job queue worker, FFmpeg pipeline
  clipwise/        React + Vite web app
  mockup-sandbox/  UI prototyping sandbox
lib/
  api-spec/        OpenAPI contract (source of truth for REST)
  api-zod/         generated request/response validation
  api-client-react/ generated React client
  db/              Drizzle schema + PostgreSQL access
```

Notable design choices:

- **Durable queue in Postgres.** Jobs are rows; advisory locks give a single active worker and crash recovery. No separate queue service.
- **Contract-first REST.** OpenAPI generates both the Zod validators and the React client.
- **Credit accounting.** Reservations are based on probed input duration; failed jobs are refunded, and each account gets free monthly minutes (free-tier clips are watermarked).
- **Safe process spawning.** FFmpeg and downloaders are always invoked with argument arrays, never shell interpolation. YouTube downloads use pinned, allowlisted HTTPS streams.
- **No secrets in logs.** Bearer keys, session cookies, private URLs and transcripts are never logged.

## Development

Requires Node 20+, pnpm, PostgreSQL, FFmpeg (with libass and H.264/AAC), and Python for the transcription model.

```bash
pnpm install
pnpm run typecheck
pnpm --filter @workspace/db run push                  # apply dev schema
pnpm --filter @workspace/api-spec run codegen         # after editing openapi.yaml
```

The hosted app uses Replit-managed auth and storage plus Stripe for credit packs; see `replit.md` for the full operating notes.

## Limits

- Vertical framing is a center crop, not speaker tracking.
- AI virality scores are estimates, not guarantees.
- Local speech recognition can struggle with music, overlapping voices, and noisy audio.
- Private, login-only, live, and DRM-protected sources are unsupported.

## License

[MIT](LICENSE)
