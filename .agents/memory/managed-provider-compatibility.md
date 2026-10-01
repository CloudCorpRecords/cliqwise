---
name: Managed provider compatibility
description: Why Clipwise uses authenticated provider proxy calls and a separate word-timestamp transcription provider.
---

Treat the current connection's returned SDK instructions as authoritative. A connected generic Stripe OAuth integration may support authenticated proxy requests while exposing no raw secret key.

**Why:** Legacy StripeSync setup assumed raw key settings and failed despite a healthy, usable Stripe connection. The actual connected proxy could access the provider normally.

**How to apply:** Use the connected provider's managed proxy without requesting another credential or reconnecting a healthy connection. Keep payment grants tied to provider-confirmed paid sessions, authenticated event retrieval, and transactional idempotency.

Use a provider that actually emits word-level timestamps for Clipwise's captions; do not infer timestamps from text or silently replace precise alignment.

**Why:** The managed OpenAI proxy rejected Whisper as an unsupported model. A supported text-only transcription response is insufficient for animated word-highlight captions.

**How to apply:** Use the connected ElevenLabs transcription service, keeping OpenAI for moment scoring. Verify capability changes against the live provider and update this note if support changes.