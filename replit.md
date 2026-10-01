# Clipwise

MCP-first AI video clipping: creators upload long-form videos or provide direct video URLs, then receive scored, captioned vertical MP4 clips.

## Run & operate

- Frontend: managed workflow `artifacts/clipwise: web`.
- API and durable queue worker: `artifacts/api-server: API Server`.
- `pnpm run typecheck` — full TypeScript check.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate clients and validation after OpenAPI changes.
- `pnpm --filter @workspace/db run push` — development schema changes. Publish handles managed production schema; do not add app startup DDL.
- `pnpm --filter @workspace/scripts exec tsx src/seed-credit-packs.ts` — idempotent Stripe product/price setup. Initial packs: 120/$12, 600/$49, 1800/$129 USD.

## Product and boundaries

- Google sign-in via Replit-managed Clerk. Configure login providers in the Auth pane; never build local password authentication.
- Each account receives 60 free processing minutes per UTC calendar month, with no rollover; paid minutes do not expire.
- Credit reservations are based on probed input duration, not output clip duration. Automatic selection spends paid minutes first. Any job using free minutes receives a watermark on every clip.
- Failed jobs refund paid credits and refund free credits only within their original monthly period.
- Streamable HTTP MCP at `/api/mcp`: exactly `submit_video` and `get_job`, bearer API key. Each call checks the live balance and requires positive available credits; web job retrieval works even at zero.
- MCP uploads use the authenticated upload-ticket endpoint, a direct PUT to App Storage, then `object_path` in `submit_video`. Do not send 4 GB files as JSON/base64.
- URLs must point to downloadable HTTP(S) video files. YouTube/watch-page extraction is not supported.
- Up to 3 hours / 4 GiB input; 1–10 clips. Vertical framing is a center crop, not automated speaker tracking.
- Caption styles: bold, minimal, karaoke. AI virality scores are estimates, not guarantees. Component scores and reasoning are retained for future selection analysis; there is no automatic model training.
- Private outputs have one-hour signed links; refresh the job to renew them.

## Implementation

- OpenAPI is the REST contract in `lib/api-spec/openapi.yaml`.
- Drizzle app schema: `lib/db/src/schema/clipwise.ts`; application data remains in PostgreSQL.
- Shared API has focused account/credits/key store, REST/MCP routes, Stripe billing and media pipeline modules under `artifacts/api-server/src/`.
- User files and MP4 outputs remain private in App Storage; local files are disposable processing intermediates.
- Queue rows persist in PostgreSQL, with advisory locks for active worker ownership and recovery.
- Browser API uses Clerk cookies; do not add explicit browser bearer tokens. MCP bearer keys are hashed at rest and shown once.
- AI moment scoring uses OpenAI through Replit AI Integrations, billed to the builder's Replit credits; these are separate from app processing credits.
- Transcription requires provider word timestamps, never guessed word timing.
- Runtime video processing needs FFmpeg with libass, H.264/AAC and DejaVu fonts. Only spawn processes with argument arrays, never shell-interpolate input.
- Development structured logging defaults to debug, production to info. Never log bearer keys, session cookies, private URLs or transcripts.

- Billing uses the connected Stripe proxy for catalog, Checkout, authenticated event/session verification and reconciliation. App purchases are transactionally idempotent.
- Speech transcription uses connected ElevenLabs Scribe with actual word timestamps, while moment scoring uses OpenAI.