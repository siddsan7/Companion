"""Authored synthetic bundles. Usage: producer-python -B generate-reviews.py PRODUCER_SRC OUTPUT.
Producer initialize/finalize/load_finalized establish the independent contract oracle.
No natural video or actual human source-review evidence is asserted.
"""
import sys, tempfile, copy
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from reel_to_md.review import initialize, finalize, load_finalized
from reel_to_md.storage import write_json, read_json
from reel_to_md.contracts import render_markdown
output = Path(sys.argv[2])
wanted = set(sys.argv[3:])
with tempfile.TemporaryDirectory(prefix='companion-authored-review-') as scratch:
    base = Path(scratch)
    evidence = {'schema_version':'1.0','clip_id':'b'*64,'duration_seconds':13.0,'pipeline_version':'authored-fixture','channels':{'audio':'available','ocr':'empty','vision':'empty'},'truncated':False,'evidence':[{'id':'a1','kind':'transcript','start_seconds':0.0,'end_seconds':13.0,'text':'Authored synthetic review fixture only.','review_flag':'normal'}]}
    target = {'schema_version':'1.0','title':'Authored synthetic review','status':'partial','claims':[{'id':'c1','text':'Authored synthetic review fixture only.','attribution':'narration','evidence_ids':['a1']}],'steps':[],'conflicts':[],'unknowns':[{'text':'OCR and vision unavailable.','basis':'missing_channel','evidence_ids':[]}],'omissions':[]}
    run = {'job_id':'b'*64,'attempt_id':'1'*32,'started_utc':'2026-11-01T10:00:00Z','input_sha256':'a'*64,'input_kind':'synthetic_fixture','result_kind':'synthetic_video_wiring','validation':'passed','state':'partial','canonical_probe':{'\ue000':'private use','\U00010000':'astral','text':'\x00\x08\x0c\n\r\t\x1f\x7f é 😀 / \\ "','numbers':[13,13.0,-0.0,1e-4,1e-5,1e15,1e16,5e-324,9007199254740993,10**100]}}
    for index, name in enumerate(['accept','edit','reject','reject-missing']):
        if wanted and name not in wanted:
            continue
        decision = 'reject' if name == 'reject-missing' else name
        attempt = base/name/'job/attempts/original'
        current_run = {**run, 'attempt_id': str(index+1)*32}
        write_json(attempt/'evidence.json',evidence)
        if name != 'reject-missing':
            write_json(attempt/'first-pass-target.json',target)
        else:
            current_run.update(state='failed', validation='failed')
        write_json(attempt/'run.json',current_run)
        (attempt/'notes.md').write_text(render_markdown(evidence,target), encoding='utf8')
        draft = initialize(attempt,base/name/'review')
        review = read_json(draft/'review.json')
        review.update(reviewer='Authored synthetic fixture reviewer',clip_key='synthetic-review',source_group='authored-synthetic',condition='B1',source_reviewed=True,source_matches_attempt=True,unit_coverage_confirmed=True,reference_inventory_complete=True,decision=decision)
        for unit in review['units']:
            unit.update(factual=True,input_support='full',source_consistent=True)
            for citation in unit['citations']: citation['supports']=True
        if decision == 'edit':
            corrected = copy.deepcopy(target)
            corrected['title']='Authored synthetic corrected review'
            review['corrected_target']=corrected
        write_json(draft/'review.json',review)
        result = finalize(draft/'review.json', output/name)
        verified=load_finalized(result)
        print(name, verified['review']['source_digest'])
