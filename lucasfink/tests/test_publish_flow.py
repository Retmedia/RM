import os, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
WORK = Path(os.environ.get("FB_TEST_WORK", "/tmp/fb_publish_tests")); WORK.mkdir(parents=True, exist_ok=True)
os.chdir(WORK)
sys.path.insert(0, str(HERE))
import csv, os, shutil, sys, importlib.util
from pathlib import Path

VID = WORK/"videos"; shutil.rmtree(VID, ignore_errors=True); VID.mkdir()

# real queue, trimmed to 12 rows, including one >90s
src = str(PROJECT/"lucas_caption_queue.csv")
rows = list(csv.DictReader(open(src, encoding="utf-8-sig")))
long_row = next(r for r in rows if int(r["duration_s"]) > 90)
pick = rows[:11] + [long_row]
for i, r in enumerate(pick, 1): r["queue_position"] = str(i)
q = WORK/"queue.csv"
with q.open("w", encoding="utf-8", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=rows[0].keys()); w.writeheader(); w.writerows(pick)

# fake video files, one deliberately missing (#5)
for i, r in enumerate(pick, 1):
    if i == 5: continue
    title = (r["final_caption"] or "untitled")[:40].replace("/", "-").replace("\n"," ")
    (VID/f"{title} [{r['video_id']}].mp4").write_bytes(os.urandom(1000 + i*10))

tok = WORK/"token"; tok.write_text("FAKETOKEN123"); tok.chmod(0o600)

import mock_graph_api as mock
PORT = mock.start()

spec = importlib.util.spec_from_file_location("fbp", str(PROJECT/"fb_publish_daily.py"))
fbp = importlib.util.module_from_spec(spec); spec.loader.exec_module(fbp)
fbp.GRAPH = f"http://127.0.0.1:{PORT}"
fbp.GRAPH_VIDEO = f"http://127.0.0.1:{PORT}"
fbp.SPACING_SECONDS = 0

def run(*argv):
    sys.argv = ["fb_publish_daily.py","--video-dir",str(VID),"--queue",str(q),
                "--token-file",str(tok),"--no-spacing"] + list(argv)
    return fbp.main()

print("\n########## 1. STATUS (fresh) ##########")
run("--status")
print("\n########## 2. DRY RUN ##########")
run("--dry-run","--limit","5")
assert not (VID/"_fb_posted.csv").exists(), "dry run wrote state!"
print("\n########## 3. REAL RUN, limit 5 ##########")
run("--limit","5")
posted = list(csv.DictReader(open(VID/"_fb_posted.csv", encoding="utf-8")))
print("state rows:", len(posted), [r["queue_position"] for r in posted])
assert len(posted) == 5, posted
assert [r["queue_position"] for r in posted] == ["1","2","3","4","6"], "wrong order/skip"
print("\n########## 4. RESUME - must not double-post ##########")
run("--limit","3")
posted2 = list(csv.DictReader(open(VID/"_fb_posted.csv", encoding="utf-8")))
print("state rows:", len(posted2), [r["queue_position"] for r in posted2])
assert len(posted2) == 8
assert len({r["video_id"] for r in posted2}) == 8, "DOUBLE POST"
print("\n########## 5. RATE LIMIT mid-run ##########")
mock.STATE["rate_limit_after"] = None
run("--limit","10")
posted3 = list(csv.DictReader(open(VID/"_fb_posted.csv", encoding="utf-8")))
print("state rows:", len(posted3))
assert len(posted3) == 11, posted3
mock.STATE["rate_limit_after"] = None
print("\n########## 6. FINISH (incl. the >90s one) ##########")
run("--limit","10")
print("\n########## 7. STATUS (end) ##########")
run("--status")

# ---- verify against mock server truth ----
pub = mock.STATE["published"]
print("\n########## VERIFICATION ##########")
print("published to API:", len(pub))
eps = {}
for p in pub: eps[p["endpoint"]] = eps.get(p["endpoint"],0)+1
print("endpoints:", eps)
assert eps.get("videos") == 1, "the >90s video did not route to /videos"
assert eps.get("video_reels") == 10, eps
for p in pub:
    if p["endpoint"]=="video_reels": assert p["state"]=="PUBLISHED", p

# captions match the queue byte for byte
qmap = {r["video_id"]: r["final_caption"] for r in pick}
posted_final = list(csv.DictReader(open(VID/"_fb_posted.csv", encoding="utf-8")))
by_pos = {r["queue_position"]: r for r in posted_final}
descs = [p["desc"] for p in pub]
expected = [qmap[by_pos[str(i)]["video_id"]] for i in sorted(int(k) for k in by_pos)]
mismatch = [ (e,d) for e,d in zip(sorted(expected), sorted(descs)) if e != d ]
print("caption mismatches:", len(mismatch))
assert not mismatch, mismatch[:2]

# bytes uploaded match file sizes
for p in pub:
    if p["endpoint"]=="video_reels":
        assert p["bytes"] > 0
print("skipped/missing file recorded:", (VID/"_fb_skipped.csv").exists())
sk = list(csv.DictReader(open(VID/"_fb_skipped.csv", encoding="utf-8")))
print("skipped rows:", [(r["queue_position"], r["attempts"], r["last_error"][:30]) for r in sk])
assert len(posted_final) == 11, f"expected 11 of 12 published (one file missing), got {len(posted_final)}"
print("\nALL ASSERTIONS PASSED")
