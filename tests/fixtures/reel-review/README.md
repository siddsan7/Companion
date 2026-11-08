# Authored finalized review fixtures

These are authored synthetic fixtures. The producer library generated and validated each bundle using `tests/fixtures/generate-reviews.py`; `source.synthetic` remains true and review split remains challenge. The accept/edit/reject labels exercise mechanics and do not establish a real human-reviewed clip handoff.

`source.json` contains original disposable scratch paths and canonical numeric/Unicode edge cases. These paths need not exist. Consumer admission must read only the portable bundle and its declared assets. The `source_digest` uses Python JSON canonicalization, not artifact-byte hashing.

Regenerate into a new output directory using the producer's locked Python environment:

    python -B tests/fixtures/generate-reviews.py ABSOLUTE_PRODUCER_SRC NEW_OUTPUT_DIRECTORY

Export the schema with `export-review-schema.py` using the same arguments, with the output JSON filename as the second argument. The producer source is read only. Hashes, review IDs and finalization times change on regeneration.
