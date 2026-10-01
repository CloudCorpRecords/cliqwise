---
name: Video source policy
description: Rationale for short-source scoring and secure YouTube downloader choices.
---

Assess an entire recording under twenty seconds as one clip rather than requiring AI-selected, self-contained moments.

**Why:** The supplied short vocal recording received valid transcription but selective moment scoring sometimes returned no usable candidates. Lowering a duration cutoff alone did not make real exports reliable.

**How to apply:** Keep actual timed words and provider-assessed scores; assess incomplete spoken or sung content honestly rather than inventing a hook, story, or payoff. Requested clip count remains a maximum.

Use a maintained, locked YouTube extractor and native direct-HTTPS media downloads, with local-only merging of separately downloaded video and audio.

**Why:** The environment's older Nix extractor could not obtain the example video. A current extractor plus separate MP4/M4A streams succeeded; requiring combined video/audio excludes many ordinary public YouTube videos.

**How to apply:** Retain public-IP pinning and provider/CDN restrictions for every network request. Do not add generic extractor, HLS, cookie, login, or remote-component fallbacks to avoid a provider restriction.