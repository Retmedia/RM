import os, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
WORK = Path(os.environ.get("FB_TEST_WORK", "/tmp/fb_publish_tests")); WORK.mkdir(parents=True, exist_ok=True)
os.chdir(WORK)
sys.path.insert(0, str(HERE))
import csv, os, shutil, sys, importlib.util
from pathlib import Path
VID = WORK/"v2"; shutil.rmtree(VID, ignore_errors=True); VID.mkdir()
rows = list(csv.DictReader(open(str(PROJECT/"lucas_caption_queue.csv"), encoding="utf-8-sig")))
pick = rows[:8]
for i,r in enumerate(pick,1): r["queue_position"]=str(i)
q = WORK/"q2.csv"
with q.open("w",encoding="utf-8",newline="") as fh:
    w=csv.DictWriter(fh,fieldnames=rows[0].keys()); w.writeheader(); w.writerows(pick)
for r in pick: (VID/f"clip [{r['video_id']}].mp4").write_bytes(os.urandom(2048))
tok = WORK/"token"; tok.write_text("FAKETOKEN123"); tok.chmod(0o600)
import mock_graph_api as mock; PORT = mock.start()
mock.STATE["published"]=[]; mock.STATE["reels"]={}; mock.STATE["uploads"]={}
spec = importlib.util.spec_from_file_location("fbp",str(PROJECT/"fb_publish_daily.py"))
fbp = importlib.util.module_from_spec(spec); spec.loader.exec_module(fbp)
fbp.GRAPH=f"http://127.0.0.1:{PORT}"; fbp.GRAPH_VIDEO=f"http://127.0.0.1:{PORT}"
def run(*a):
    sys.argv=["x","--video-dir",str(VID),"--queue",str(q),"--token-file",str(tok),"--no-spacing"]+list(a)
    return fbp.main()

print("===== A. rate limited after 3 =====")
mock.STATE["rate_limit_after"]=3
run("--limit","8")
n=len(list(csv.DictReader(open(VID/"_fb_posted.csv",encoding="utf-8"))))
print("-> published before stop:", n); assert n==3, n
assert not (VID/"_fb_skipped.csv").exists(), "rate limit must NOT count as a video failure"

print("\n===== B. next day, limit lifted, resumes at #4 =====")
mock.STATE["rate_limit_after"]=None
run("--limit","8")
st=list(csv.DictReader(open(VID/"_fb_posted.csv",encoding="utf-8")))
print("-> total:", len(st), [r["queue_position"] for r in st])
assert [r["queue_position"] for r in st]==[str(i) for i in range(1,9)], st
assert len({r["video_id"] for r in st})==8, "DOUBLE POST"

print("\n===== C. queue exhausted =====")
run("--limit","8")

print("\n===== D. auth failure stops immediately =====")
VID3 = WORK/"v3"; shutil.rmtree(VID3, ignore_errors=True); VID3.mkdir()
for r in pick: (VID3/f"clip [{r['video_id']}].mp4").write_bytes(os.urandom(2048))
orig = fbp.graph_post
def bad(url, params, timeout=120):
    if params.get("upload_phase")=="start":
        raise fbp.GraphError("Error validating access token: Session has expired", code=190, http_status=400)
    return orig(url,params,timeout)
fbp.graph_post = bad
sys.argv=["x","--video-dir",str(VID3),"--queue",str(q),"--token-file",str(tok),"--no-spacing","--limit","8"]
fbp.main()
assert not (VID3/"_fb_posted.csv").exists()
assert not (VID3/"_fb_skipped.csv").exists(), "auth failure must not be charged to the video"
fbp.graph_post = orig

print("\n===== E. one poison video is set aside after 3 attempts =====")
VID4 = WORK/"v4"; shutil.rmtree(VID4, ignore_errors=True); VID4.mkdir()
for r in pick: (VID4/f"clip [{r['video_id']}].mp4").write_bytes(os.urandom(2048))
bad_id = pick[0]["video_id"]
def poison(url, params, timeout=120):
    if params.get("upload_phase")=="start" and getattr(poison,"target",None):
        raise fbp.GraphError("Video file is corrupt", code=390, http_status=400)
    return orig(url,params,timeout)
real_reel = fbp.publish_reel
def wrapped(page_id, token, path, caption):
    if bad_id in path.name:
        raise fbp.GraphError("Video file is corrupt", code=390, http_status=400)
    return real_reel(page_id, token, path, caption)
fbp.publish_reel = wrapped
for day in (1,2,3,4):
    print(f"-- day {day} --")
    sys.argv=["x","--video-dir",str(VID4),"--queue",str(q),"--token-file",str(tok),"--no-spacing","--limit","2"]
    fbp.main()
sk=list(csv.DictReader(open(VID4/"_fb_skipped.csv",encoding="utf-8")))
print("-> skipped:", [(r["queue_position"],r["attempts"]) for r in sk])
assert sk[0]["attempts"]=="3", sk
st=list(csv.DictReader(open(VID4/"_fb_posted.csv",encoding="utf-8")))
print("-> published:", [r["queue_position"] for r in st])
assert "1" not in [r["queue_position"] for r in st]
assert len(st)>=6, "poison video blocked the queue"
print("\nALL PASSED")
