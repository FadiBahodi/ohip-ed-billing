"""Local synthetic-fixture runner. Never serves as a patient-note endpoint."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json, re
ROOT=Path(__file__).resolve().parent.parent
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(ROOT),**kw)
    def do_POST(self):
        if self.path!='/__qa_result': self.send_error(404); return
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<2000000: self.send_error(400);return
        body=json.loads(self.rfile.read(size)); model=body.get('model','')
        allowed={'sparse','colloquial-repair','shock-estimate','interrupted-resus','respiratory','negative-procedure','stable-long-stay','reassessment','pressor-shorthand','waiting-for-ride','face-repair','sedation-role'}
        if not re.fullmatch(r'Qwen3(?:\.5)?-[24]B-q4f16_1-MLC',model) or not all(r.get('fixture') in allowed for r in body.get('results',[])): self.send_error(400);return
        dest=ROOT/'qa'/'results';dest.mkdir(exist_ok=True)
        (dest/(model+'.json')).write_text(json.dumps(body,indent=2))
        self.send_response(204);self.end_headers()
ThreadingHTTPServer(('127.0.0.1',8772),Handler).serve_forever()
