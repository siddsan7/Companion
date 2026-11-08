"""Authored malformed/unsupported bundles, independently classified by producer loader.
Usage: producer-python -B generate-review-holds.py PRODUCER_SRC FIXTURE_ROOT OUTPUT [CASE...]
The loader intentionally has a few consumer admission gaps. Those are recorded explicitly.
"""
import sys, shutil
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from reel_to_md.review import load_finalized
from reel_to_md.storage import read_json, write_json, digest, file_hash
fixtures, output = Path(sys.argv[2]), Path(sys.argv[3])
cases = sys.argv[4:] or ['source-digest', 'unknown-classification', 'missing-hash', 'legacy-review', 'pending-label', 'scores-mismatch', 'exports-mismatch', 'exports-missing', 'asset-unlisted', 'unsafe-path', 'reject-invalid-evidence', 'mismatched-clip-identity', 'unsafe-evidence-integer']
consumer_gaps = {'missing-hash', 'exports-mismatch', 'exports-missing', 'reject-invalid-evidence', 'mismatched-clip-identity', 'unsafe-evidence-integer', 'date-only-source-time'}
for case in cases:
    destination = output/case
    if destination.exists():
        raise ValueError('Use new fixture output directories')
    original = fixtures/('reject' if case.startswith('reject-') else 'accept')
    load_finalized(original)
    shutil.copytree(original, destination)
    source = read_json(destination/'source.json')
    review = read_json(destination/'review.json')
    if case == 'source-digest':
        source['run']['canonical_probe']['numbers'].append(13.0)
    elif case == 'unknown-classification':
        source['run'].pop('input_kind', None)
        source['run'].pop('result_kind', None)
        source['synthetic'] = None
    elif case == 'missing-hash':
        source['run'].pop('input_sha256', None)
    elif case == 'legacy-review':
        review.pop('source_reviewed')
    elif case == 'pending-label':
        review['units'][0]['factual'] = None
    elif case == 'scores-mismatch':
        metrics = read_json(destination/'scores.json')
        metrics['source_error_rate']['numerator'] = 1
        write_json(destination/'scores.json', metrics)
    elif case == 'exports-mismatch':
        target = read_json(destination/'reviewed-target.json')
        target['title'] = 'Unselected authored target'
        write_json(destination/'reviewed-target.json', target)
    elif case == 'exports-missing':
        (destination/'reviewed-notes.md').unlink()
    elif case == 'asset-unlisted':
        source['assets'].append({'file':'assets/missing.png', 'sha256':'f'*64})
    elif case == 'reject-invalid-evidence':
        source['evidence']['evidence'][0]['end_seconds'] = 100.0
    elif case == 'mismatched-clip-identity':
        source['evidence']['clip_id'] = 'd'*64
    elif case == 'unsafe-evidence-integer':
        source['evidence']['duration_seconds'] = 9007199254740993
    elif case == 'date-only-source-time':
        source['run']['started_utc'] = '2026-11-01'
    elif case != 'unsafe-path':
        raise ValueError('Unknown fixture case')
    if case != 'source-digest':
        review['source_digest'] = digest(source)
    write_json(destination/'source.json', source)
    write_json(destination/'review.json', review)
    manifest = read_json(destination/'manifest.json')
    # Distinct finalization IDs avoid accidental immutable identity collisions in
    # multi-candidate desktop scenarios. They remain deterministic fixture labels.
    import hashlib
    manifest['finalization_id'] = hashlib.sha256(case.encode()).hexdigest()[:32]
    manifest['files'] = {file.relative_to(destination).as_posix():file_hash(file) for file in sorted(destination.rglob('*')) if file.is_file() and file.name != 'manifest.json'}
    if case == 'unsafe-path':
        manifest['files']['../outside.txt'] = 'f'*64
    write_json(destination/'manifest.json', manifest)
    try:
        load_finalized(destination)
        result = 'producer loader accepts; consumer must hold'
        if case not in consumer_gaps:
            raise AssertionError('Producer unexpectedly accepted malformed fixture '+case)
    except (ValueError, KeyError, OSError) as error:
        if case in consumer_gaps:
            raise AssertionError('Expected producer loader admission gap changed: '+case) from error
        result = 'producer loader rejects'
    print(case, result)
