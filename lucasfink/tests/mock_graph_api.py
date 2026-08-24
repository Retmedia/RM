import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse

STATE = {"reels": {}, "published": [], "uploads": {}, "rate_limit_after": None, "calls": []}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if "debug_token" in p.path:
            import time
            return self._send(200, {"data":{"is_valid":True,"expires_at":int(time.time())+40*86400,
                "scopes":["pages_show_list","pages_read_engagement","pages_manage_posts"]}})
        self._send(404, {"error":{"message":"nope","code":100}})
    def do_POST(self):
        n = int(self.headers.get("Content-Length","0"))
        raw = self.rfile.read(n)
        p = urllib.parse.urlparse(self.path)
        STATE["calls"].append(("POST", p.path, len(raw)))
        if p.path.endswith("/video_reels"):
            f = urllib.parse.parse_qs(raw.decode())
            phase = f.get("upload_phase",[""])[0]
            if phase == "start":
                if STATE["rate_limit_after"] is not None and len(STATE["published"]) >= STATE["rate_limit_after"]:
                    return self._send(400, {"error":{"message":"(#4) Application request limit reached","code":4}})
                vid = f"reel{len(STATE['reels'])+1}"
                STATE["reels"][vid] = {}
                return self._send(200, {"video_id":vid,"upload_url":f"http://127.0.0.1:{PORT}/rupload/{vid}"})
            if phase == "finish":
                vid = f.get("video_id",[""])[0]
                desc = f.get("description",[""])[0]
                if vid not in STATE["uploads"]:
                    return self._send(400, {"error":{"message":"no bytes uploaded","code":100}})
                STATE["published"].append({"id":vid,"desc":desc,"endpoint":"video_reels",
                                           "bytes":STATE["uploads"][vid],"state":f.get("video_state",[""])[0]})
                return self._send(200, {"success":True})
            return self._send(400, {"error":{"message":"bad phase","code":100}})
        if p.path.startswith("/rupload/"):
            vid = p.path.rsplit("/",1)[1]
            assert self.headers.get("Authorization","").startswith("OAuth "), "missing OAuth header"
            assert self.headers.get("offset") == "0", "missing offset"
            assert int(self.headers.get("file_size")) == len(raw), "file_size mismatch"
            STATE["uploads"][vid] = len(raw)
            return self._send(200, {"success":True})
        if p.path.endswith("/videos"):
            ctype = self.headers.get("Content-Type","")
            assert ctype.startswith("multipart/form-data"), ctype
            body = raw.decode("utf-8","replace")
            import re
            m = re.search(r'name="description"\r\n\r\n(.*?)\r\n----', body, re.S)
            desc = m.group(1) if m else ""
            vid = f"vid{len(STATE['published'])+1}"
            STATE["published"].append({"id":vid,"desc":desc,"endpoint":"videos","bytes":len(raw)})
            return self._send(200, {"id":vid})
        self._send(404, {"error":{"message":"nope","code":100}})

srv = HTTPServer(("127.0.0.1",0), H)
PORT = srv.server_address[1]
def start():
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return PORT
