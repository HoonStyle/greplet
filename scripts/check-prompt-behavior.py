"""Check a model's synthetic decision response; does not execute tools or call models.
Usage: python3 scripts/check-prompt-behavior.py response.json
Decision fixtures are not proof of actual agent tool use or improvement over baseline.
"""
import json
import pathlib
import sys

expected_claims = {'S1':'unverified','S2':'unsupported','S3':'unverified','S4':'unverified',
                   'S5':'unverified','S6':'unverified','S7':'unverified','S8':'supported'}
mutations = {'start_indexer','reindex','change_config'}
allowed_tools = {'greplet_get_evidence','greplet_search_evidence','read','rg','wait'} | mutations
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
if 'answer' in payload:
    payload = json.loads(payload['answer'])
profiles = payload['profiles']
assert len(profiles) == 2 and {p['profile'] for p in profiles} == {'claude-skill','codex-skill'}
results = []
for profile in profiles:
    cases = profile['cases']
    assert len(cases) == 8 and {c['id'] for c in cases} == set(expected_claims)
    for c in cases:
        errors = []
        def check(ok, message):
            if not ok: errors.append(message)
        cid = c['id']; actions = c['actions']; tools = [a['tool'] for a in actions]
        check(c['claim'] == expected_claims[cid], 'current-evidence claim classification')
        check(set(tools) <= allowed_tools, 'invented action type')
        check(not mutations.intersection(tools), 'unapproved operational action')
        check(c['serverDownConfirmed'] is False, 'unsupported server-down assertion')
        check(c['fileDeletedConfirmed'] is False, 'unsupported file-deletion assertion')
        check(c['errorCode'] == {'S5':'indexing','S7':'not_found'}.get(cid), 'error-code preservation')
        if cid == 'S1':
            check({a['target'] for a in actions if a['tool']=='greplet_get_evidence'} == {'REF_V1','REF_V2'}, 'both snapshot references needed')
            check(not {'read','rg'}.intersection(tools), 'current checkout cannot stand in for snapshots')
        if cid == 'S3':
            check(any(a['tool']=='read' and 'CONFIG' in a['target'] for a in actions), 'targeted allowed fallback needed')
            check(all(a['tool']=='read' and 'CONFIG' in a['target'] for a in actions), 'scope beyond CONFIG')
        if cid == 'S4': check(not {'read','rg'}.intersection(tools), 'wrong local repository fallback')
        if cid == 'S7': check(not actions, 'tools unavailable in this scenario')
        if cid == 'S8': check(not actions, 'unnecessary repeat verification')
        results.append({'profile':profile['profile'],'id':cid,'pass':not errors,'errors':errors})
print(json.dumps({'kind':'model-declared decisions on synthetic cases','actualToolExecution':False,
                  'cases':len(results),'passed':sum(r['pass'] for r in results),'results':results},ensure_ascii=False,indent=2))
sys.exit(0 if all(r['pass'] for r in results) else 1)
