"""Build a static, provenance-linked public guidance bundle using Lamina.

Only manifest-listed public URLs are ingested. No clinical note input exists.
Raw snapshots and Lamina's workspace stay local; the website receives short
excerpts, editorial summaries, hashes, locators and rule links.
"""
from pathlib import Path
from urllib.request import Request,urlopen
import hashlib,json,re,argparse
from lxml import html
from lamina.ingest import ingest_paths
from lamina.store import Workspace
from lamina.validation import validate_evidence
ROOT=Path(__file__).resolve().parent.parent

def build(refresh=False):
    manifest=json.loads((ROOT/'sources/manifest.json').read_text())
    cache=ROOT/'.source-cache'; cache.mkdir(exist_ok=True)
    workspace=Workspace(cache/'lamina'); sources=[]; bindings={}
    for spec in manifest['sources']:
        raw_file=cache/(spec['key']+'.html'); text_file=cache/(spec['key']+'.txt')
        if refresh or not raw_file.exists():
            with urlopen(Request(spec['url'],headers={'User-Agent':'Folio public-source review/1.0'}),timeout=30) as r:
                raw_file.write_bytes(r.read())
        raw=raw_file.read_bytes(); tree=html.fromstring(raw); main=tree.xpath('//main')
        if not main: raise ValueError('Source page has no main content')
        blocks=[]
        for el in main[0].xpath('.//h1|.//h2|.//h3|.//h4|.//p|.//li'):
            if el.tag=='li' and el.xpath('.//p'): continue
            text=' '.join(el.text_content().split())
            if text: blocks.append(text)
        text_file.write_text('\n\n'.join(blocks))
        ingest_paths([text_file],workspace)
        checksum=hashlib.sha256(text_file.read_bytes()).hexdigest()
        source=next(s for s in workspace.sources() if s['sha256']==checksum)
        units=[u for u in workspace.units() if u['source_id']==source['id']]
        unit=next((u for u in units if spec['anchor'] in u['text']),None)
        if unit is None: raise ValueError('Source changed: evidence anchor missing for '+spec['key'])
        evidence=validate_evidence([{'unit_id':unit['id'],'quote':spec['anchor']}],{u['id']:u for u in units},spec['key'])
        item={**spec,'sourceId':source['id'],'textSha256':checksum,'htmlSha256':hashlib.sha256(raw).hexdigest(),'unitId':unit['id'],'locator':unit['locator'],'quote':evidence[0]['quote'],'checkedOn':manifest['checkedOn'],'kind':'official-guidance-with-editorial-summary'}
        sources.append(item)
        for rule in spec['rules']: bindings.setdefault(rule,[]).append(spec['key'])
    payload={k:v for k,v in manifest.items() if k!='sources'}
    payload.update(sources=sources,ruleEvidence=bindings)
    payload['bundleSha256']=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
    encoded=json.dumps(payload,ensure_ascii=False,indent=2)
    (ROOT/'engine/source-bundle.js').write_text('globalThis.FOLIO_SOURCES = '+encoded+';\nif(typeof module==="object"&&module.exports) module.exports=globalThis.FOLIO_SOURCES;\n')
    print(json.dumps({'sources':len(sources),'rules':len(bindings),'bundleSha256':payload['bundleSha256'],'lamina':manifest['laminaCommit']}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--refresh',action='store_true');build(p.parse_args().refresh)
