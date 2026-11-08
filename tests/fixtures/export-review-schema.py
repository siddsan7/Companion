"""Copy the read-only producer review schema. Usage: python -B export-review-schema.py PRODUCER_SRC OUTPUT."""
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from reel_to_md.review import REVIEW_SCHEMA
Path(sys.argv[2]).write_text(json.dumps(REVIEW_SCHEMA, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
