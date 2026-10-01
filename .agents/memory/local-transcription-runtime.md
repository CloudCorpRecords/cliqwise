---
name: Local transcription runtime
description: Why transcription moved local and the non-obvious Replit/PyAV runtime compatibility constraints.
---

Keep speech recognition local unless the user explicitly chooses an external transcription service.

**Why:** The user requested own transcription after ElevenLabs Scribe repeatedly returned `quota_exceeded`, despite successful general account reads. Word-timed captions must remain real model output; the change is not permission to fabricate timestamps or scoring.

**How to apply:** Download only public model weights during setup, never upload user audio to a transcription provider, and retain separate real AI scoring. Local ASR can misrecognize lyrics, noisy recordings, or overlapping voices; do not claim perfect transcripts.

Keep the managed Python module's major/minor version consistent with the interpreter used to install locked native wheels.

**Why:** Replit rewrote the .pythonlibs Python entrypoint to its managed 3.13 wrapper while uv had installed 3.12 wheels. Successful uv setup alone did not ensure subsequent subprocesses could import them. Aligning the managed module with the installer resolved this.

**How to apply:** After changing Python modules or installing native inference packages, verify the default runtime in a new tool/workflow context, not only inside the installation command. Derive GCC runtime library locations rather than hardcoding Nix store hashes.

Check the PyAV/faster-whisper API boundary when upgrading either dependency.

**Why:** PyAV 19 removed the optional metadata_errors argument still passed by faster-whisper 1.2.1; native library imports succeeded before actual decoding failed.

**How to apply:** Retain a narrow compatibility adapter only while needed, and exercise real local decoding/transcription after dependency upgrades.