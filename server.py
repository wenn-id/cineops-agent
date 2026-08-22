from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", 8000
DIST = Path(__file__).resolve().parent / "dist"

if __name__ == "__main__":
    if not (DIST / "index.html").is_file():
        raise SystemExit("dist/ not found — run `npm run build` (or `npm start`) first")
    print(f"CineOps Agent running at http://{HOST}:{PORT} (serving dist/ only)")
    ThreadingHTTPServer((HOST, PORT), partial(SimpleHTTPRequestHandler, directory=str(DIST))).serve_forever()
