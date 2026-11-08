# Authored producer-compatible fixture

`example.json` and the two application schema files were copied from the local Reel to MD producer (`docs/examples/example.json`, `src/reel_to_md/schemas/`) on 2026-11-07. The example is explicitly synthetic and illustrates conflicting/uncertain extractions. It is not a real clip or a claim about guitar learning.

The producer's installed Python `reel_to_md.contracts.render_markdown` generated `notes.md` from the example. The desktop fixture builder adds supported producer run metadata, stable declared source hashes and distinct attempt identities, and binds evidence clip identity to the job. No media is fabricated or copied. The separate real handoff uses an actual completed producer attempt.
