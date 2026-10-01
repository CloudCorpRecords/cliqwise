---
name: Managed provider compatibility
description: Historical managed-provider constraints and how to diagnose provider authorization without unnecessary reconnection.
---

Treat the current connection's returned SDK instructions as authoritative. A connected generic Stripe OAuth integration may support authenticated proxy requests while exposing no raw secret key.

**Why:** Legacy StripeSync setup assumed raw key settings and failed despite a healthy, usable Stripe connection. The actual connected proxy could access the provider normally.

**How to apply:** Use the connected provider's managed proxy without requesting another credential or reconnecting a healthy connection. Keep payment grants tied to provider-confirmed paid sessions, authenticated event retrieval, and transactional idempotency.

If considering an external transcription service again, verify that it actually emits word-level timestamps; do not infer timestamps from text.

**Why:** The managed OpenAI proxy rejected Whisper as an unsupported model. A supported text-only transcription response is insufficient for animated word-highlight captions.

**How to apply:** Current transcription is local by user decision; see local-transcription-runtime.md. Keep OpenAI for scoring. Do not reintroduce a provider dependency without user agreement and a real timestamp-capability check.

Do not infer Scribe access from successful model/subscription reads or the general character allowance.

**Why:** Scribe returned HTTP 401 with the exact provider code `quota_exceeded` while model/subscription reads succeeded and the account was below its general character limit. Reconnecting a healthy API-key connection or claiming overall quota exhaustion would be unsupported.

**How to apply:** Preserve safe provider error codes and diagnose speech-to-text-specific access/limits. Do not fake timestamps, hide a provider failure as no speech, or mark export verification complete when transcription is blocked.