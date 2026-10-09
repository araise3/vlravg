"""Local-only break-ui preview. Production index.html is never modified.

Run: python scripts/serve-ui-stress.py
Open: http://127.0.0.1:8767/stress-test?data=worst
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            self.send_error(503, 'Live API disabled in fixture preview')
            return
        if path == '/stress-test':
            content = (ROOT / 'scripts/ui-stress-shell.html').read_bytes()
        elif path == '/' or path.startswith('/player/') or path in ['/matches', '/duos', '/rr', '/servers', '/lobbyrank', '/names']:
            content = (ROOT / 'index.html').read_text(encoding='utf-8')
            fixture = (ROOT / 'scripts/ui-stress-fixtures.js').read_text(encoding='utf-8')
            marker = 'applyPage();\nloadPlayerFromRoute();'
            if marker not in content:
                self.send_error(500, 'Frontend initialization marker changed')
                return
            content = content.replace(marker, fixture + '\napplyPage();\nloadPlayerFromRoute();')
            content = content.encode('utf-8')
        else:
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(content)


if __name__ == '__main__':
    print('UI stress preview: http://127.0.0.1:8767/stress-test?data=worst', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8767), Handler).serve_forever()
