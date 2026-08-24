import os, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
WORK = Path(os.environ.get("FB_TEST_WORK", "/tmp/fb_publish_tests")); WORK.mkdir(parents=True, exist_ok=True)
os.chdir(WORK)
sys.path.insert(0, str(HERE))
import csv, os, shutil, sys, importlib.util, subprocess, time
from pathlib import Path
VID = WORK/"v5"; shutil.rmtree(VID, ignore_errors=True); VID.mkdir()
rows = list(csv.DictReader(open(str(PROJECT/"lucas_caption_queue.csv"), encoding="utf-8-sig")))[:4]
for i,r in enumerate(rows,1): r["queue_position"]=str(i)
q = WORK/"q3.csv"
with q.open("w",encoding="utf-8",newline="") as fh:
    w=csv.DictWriter(fh,fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
for r in rows: (VID/f"clip [{r['video_id']}].mp4").write_bytes(os.urandom(2048))
sys.path.insert(0,str(HERE)); tok = WORK/"token"; tok.write_text("FAKETOKEN123"); tok.chmod(0o600)
import mock_graph_api as mock; PORT=mock.start()
mock.STATE["published"]=[]; mock.STATE["uploads"]={}; mock.STATE["reels"]={}
spec = importlib.util.spec_from_file_location("fbp",str(PROJECT/"fb_publish_daily.py"))
fbp = importlib.util.module_from_spec(spec); spec.loader.exec_module(fbp)
fbp.GRAPH=f"http://127.0.0.1:{PORT}"; fbp.GRAPH_VIDEO=f"http://127.0.0.1:{PORT}"

# hold the lock as if another run were live
held = fbp.acquire_lock(VID/"_fb_publish.lock")
assert held is not None
sys.argv=["x","--video-dir",str(VID),"--queue",str(q),"--token-file",str(tok),"--no-spacing","--limit","4"]
print("== run while lock is held ==")
fbp.main()
assert not (VID/"_fb_posted.csv").exists(), "second run posted despite the lock!"
print("-> correctly refused\n")

# --status must still work while locked
print("== status while locked ==")
sys.argv=["x","--video-dir",str(VID),"--queue",str(q),"--token-file",str(tok),"--status"]
fbp.main()

import fcntl; fcntl.flock(held, fcntl.LOCK_UN); held.close()
print("\n== lock released, run proceeds ==")
sys.argv=["x","--video-dir",str(VID),"--queue",str(q),"--token-file",str(tok),"--no-spacing","--limit","4"]
fbp.main()
n=len(list(csv.DictReader(open(VID/"_fb_posted.csv",encoding="utf-8"))))
assert n==4, n
print("-> published", n)
print("\nLOCK TEST PASSED")
