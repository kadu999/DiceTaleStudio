import http.server, socketserver, urllib.request, json, os, time, sys

UPSTREAM = "http://192.168.8.182:8090"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
counter = [0]

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _handle(self):
        n = counter[0]; counter[0] += 1
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        req_headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in ("host", "content-length", "connection", "accept-encoding")}
        url = UPSTREAM + self.path
        req = urllib.request.Request(url, data=body or None, method=self.command,
                                     headers=req_headers)
        rec = {"n": n, "method": self.command, "path": self.path,
               "req_headers": req_headers,
               "req_body_len": len(body), "ts": time.time()}
        try:
            body_text = body.decode("utf-8", "replace")
        except Exception:
            body_text = None
        rec["req_body"] = body_text
        t0 = time.time()
        resp_status = None; resp_body = b""; err = None
        try:
            upstream = urllib.request.urlopen(req, timeout=600)
            resp_status = upstream.status
            self.send_response(resp_status)
            for k, v in upstream.headers.items():
                if k.lower() in ("transfer-encoding", "connection", "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            while True:
                chunk = upstream.read1(65536)
                if not chunk:
                    break
                resp_body += chunk
                self.wfile.write(chunk)
            self.wfile.flush()
        except urllib.error.HTTPError as e:
            resp_status = e.code
            resp_body = e.read()
            err = None
            self.send_response(resp_status)
            ct = e.headers.get("Content-Type")
            if ct: self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            msg = json.dumps({"proxy_error": err}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
        rec["resp_status"] = resp_status
        rec["resp_time_s"] = round(time.time() - t0, 2)
        rec["resp_body_head"] = resp_body[:3000].decode("utf-8", "replace")
        rec["proxy_error"] = err
        with open(os.path.join(OUT_DIR, f"capture-{n:03d}.json"), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
        print(f"[{n}] {self.command} {self.path} -> {resp_status} "
              f"req={len(body)}B resp={len(resp_body)}B {rec['resp_time_s']}s", flush=True)

    do_GET = do_POST = _handle

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 18090), Handler) as srv:
    print("capture proxy on 127.0.0.1:18090 ->", UPSTREAM, flush=True)
    srv.serve_forever()
