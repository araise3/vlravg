"""Serve the local replay library with bounded native-movement visibility jobs."""
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import argparse
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import sys
from threading import Lock
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILES = ('build-replay-visibility.py', 'analyze-replay-visibility.cjs',
                'replay-transcription-viewer.js', 'replay-behavior-runtime.js',
                'replay-visibility-runtime.js', 'replay-visibility-effects.js',
                'replay_visibility_inputs.py', 'replay_camera_body.py', 'replay_bitwindows.py',
                'replay_smoke_profiles.py', 'replay_ability_occluders.py', 'replay_dynamic_occluders.py',
                'replay_asset_model.py', 'replay_status.py', 'replay_transcription.py',
                'build-native-visibility-bindings.py',
                'probe-dynamic-map-assets.py', 'inspect-transcription-assets.py',
                'audit-map-art-overlay.py', 'export-transcription-map.py')


class InvalidRequest(ValueError):
    pass


class QueueFull(RuntimeError):
    pass


def file_sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


class VisibilityJobs:
    def __init__(self, corpus, review, runner=None, max_pending=8):
        self.corpus = Path(corpus).resolve()
        self.review = Path(review).resolve()
        self.records = {r['match_id']: r for r in json.loads(self.corpus.read_text())['replays']
                        if r['status'] == 'validated'}
        self.results = self.review / 'visibility-results'
        self.results.mkdir(exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='visibility')
        self.lock = Lock()
        self.jobs = {}
        self.runner = runner or self.run
        self.max_pending = max_pending
        self.hashes = {}

    def fingerprint(self, path):
        path = Path(path)
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        with self.lock:
            digest = self.hashes.get(key)
        if digest is None:
            digest = file_sha(path)
            with self.lock:
                self.hashes[key] = digest
        return digest

    def validate(self, payload):
        required = {'match_id', 'observer', 'target', 'start_ms', 'end_ms'}
        allowed = required | {'smoke', 'crouch'}
        if not isinstance(payload, dict) or not required <= payload.keys() or payload.keys() - allowed:
            raise InvalidRequest('Expected a replay, opposing player pair and time window')
        match = payload['match_id']
        if not isinstance(match, str) or match not in self.records:
            raise InvalidRequest('Replay is not in the validated local library')
        record = self.records[match]
        manifest = json.loads((Path(record['export']) / 'manifest.json').read_text())
        subjects = {p['subject'] for p in manifest['players']}
        for name in ('observer', 'target'):
            if not isinstance(payload[name], str) or payload[name] not in subjects:
                raise InvalidRequest('Player is not in this replay')
        if payload['observer'] == payload['target']:
            raise InvalidRequest('Observer and target must differ')
        start, end = payload['start_ms'], payload['end_ms']
        if type(start) is not int or type(end) is not int or not 0 <= start < end < manifest['duration_ms']:
            raise InvalidRequest('Time window must be inside this replay')
        if end - start > 300000:
            raise InvalidRequest('Select a window of at most five minutes')
        if any(type(payload.get(name, True)) is not bool for name in ('smoke', 'crouch')):
            raise InvalidRequest('Model options must be boolean')
        return {**payload, 'smoke': payload.get('smoke', True), 'crouch': payload.get('crouch', True)}

    def signature(self, payload):
        record = self.records[payload['match_id']]
        directory = self.review / 'library' / payload['match_id']
        export = Path(record['export'])
        paths = [self.corpus, directory / 'replay.json', directory / 'viewer.html',
                 export / 'manifest.json', export / 'movement.parquet', export / 'fields.parquet', export / 'actors.parquet',
                 export / 'net_guids.parquet',
                 *[ROOT / 'scripts' / name for name in SOURCE_FILES]]
        local = ROOT / '.local/replay-transcripts'
        research = local / 'asset-research'
        smoke = research / 'visibility-smoke-profiles-v1'
        dynamic_assets = research / 'dynamic-map-assets-v3.json'
        optional = [
            self.review / 'visibility-inputs' / (payload['match_id'] + '.json'),
            research / 'visibility-effects-v1/rules.json',
            smoke / 'smoke-model.json', smoke / 'source.json',
            local / 'corpus-asset-model.json',
            smoke / 'replays' / (payload['match_id'] + '.json'),
            research / 'ability-occluders-v1/model.json',
            self.review / 'ability-occluder-inputs-v1' / (payload['match_id'] + '.json'),
            dynamic_assets,
            research / 'dynamic-map-replay-evidence-v3/index.json',
            research / 'dynamic-map-replay-evidence-v3' / (payload['match_id'] + '.json'),
        ]
        bindings_path = research / 'native-visibility-bindings-v1/bindings.json'
        optional.append(bindings_path)
        if bindings_path.exists():
            bindings = json.loads(bindings_path.read_text(encoding='utf-8'))
            source = research / 'installed-behavior-source-v5'
            optional.extend([source / 'manifest.json', source / 'index.jsonl'])
            optional.extend(source / row['file'] for row in bindings.get('sources', {}).values())
        # Validators also read the source snapshots behind these models. A
        # changed snapshot must not reuse an already completed native report.
        if (smoke / 'smoke-model.json').exists():
            model = json.loads((smoke / 'smoke-model.json').read_text(encoding='utf-8'))
            provenance = model.get('source_provenance', {})
            for name in ('source_json_file', 'canonical_model_file'):
                if provenance.get(name):
                    optional.append(Path(provenance[name]))
        if dynamic_assets.exists():
            assets = json.loads(dynamic_assets.read_text(encoding='utf-8'))
            behavior = research / 'installed-behavior-source-v5'
            optional.append(behavior / 'manifest.json')
            for class_record in assets.get('class_records', []):
                if class_record.get('receipt', {}).get('file'):
                    optional.append(behavior / class_record['receipt']['file'])
        if record.get('map_path', '').rsplit('/', 1)[-1] == 'Jam':
            overlay = local / 'map-Jam-static-art-overlay-v1'
            optional.extend([overlay / 'map.json', overlay / 'geometry.npz'])
            base = local / 'map-Jam-13.06'
            optional.extend([base / 'map.json', base / 'geometry.npz'])
        sources = {str(p.resolve()): self.fingerprint(p) for p in paths}
        sources.update({str(p.resolve()): self.fingerprint(p) if p.exists() else None for p in optional})
        encoded = json.dumps({'request': payload, 'sources': sources},
                             sort_keys=True, separators=(',', ':')).encode()
        return hashlib.sha256(encoded).hexdigest()

    def submit(self, payload):
        payload = self.validate(payload)
        key = self.signature(payload)
        with self.lock:
            if key in self.jobs and self.jobs[key]['status'] != 'failed':
                return dict(self.jobs[key])
            if sum(j['status'] in ('queued', 'running') for j in self.jobs.values()) >= self.max_pending:
                raise QueueFull('Visibility analysis queue is full; wait for the current job')
            path = self.results / (key + '.json')
            cached = False
            if path.exists():
                try:
                    self.validate_report(json.loads(path.read_text()), payload)
                    cached = True
                except (ValueError, KeyError, TypeError):
                    path.unlink()
            job = {'id': key, 'status': 'complete' if cached else 'queued', 'request': payload}
            if cached:
                job['report_url'] = '/visibility-results/' + path.name
            self.jobs[key] = job
            if not cached:
                self.pool.submit(self.execute, key, payload, path)
            return dict(job)

    @staticmethod
    def validate_report(report, payload):
        if (report['match_id'] != payload['match_id'] or report['observer'] != payload['observer']
                or report['target'] != payload['target'] or report['window_ms'] != [payload['start_ms'], payload['end_ms']]
                or report.get('display_models') != {'smoke': payload['smoke'], 'crouch': payload['crouch']}
                or not isinstance(report.get('samples'), list)):
            raise ValueError('Analysis result does not match the requested encounter')

    def execute(self, key, payload, path):
        with self.lock:
            self.jobs[key]['status'] = 'running'
        try:
            self.runner(payload, path)
            report = json.loads(path.read_text())
            self.validate_report(report, payload)
            if self.signature(payload) != key:
                raise ValueError('Visibility source evidence changed during analysis; submit the encounter again')
            with self.lock:
                self.jobs[key].update(status='complete', report_url='/visibility-results/' + path.name)
        except Exception as error:
            # Failed outputs never qualify as cache entries on a later startup.
            path.unlink(missing_ok=True)
            Path(str(path) + '.tmp').unlink(missing_ok=True)
            with self.lock:
                self.jobs[key].update(status='failed', error=str(error))

    def run(self, payload, path):
        command = [sys.executable, str(ROOT / 'scripts/build-replay-visibility.py'),
                   str(self.corpus), str(self.review), '--match', payload['match_id'],
                   '--observer', payload['observer'], '--target', payload['target'],
                   '--start-ms', str(payload['start_ms']), '--end-ms', str(payload['end_ms']),
                   '--out', str(path)]
        if not payload['smoke']:
            command.append('--no-smoke')
        if not payload['crouch']:
            command.append('--no-crouch')
        with path.with_suffix('.log').open('wb') as log:
            completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        if completed.returncode:
            raise RuntimeError('Native analysis failed; details are in its local visibility-results log')

    def get(self, key):
        with self.lock:
            return dict(self.jobs[key]) if key in self.jobs else None

    def close(self):
        self.pool.shutdown(wait=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, jobs, **kwargs):
        self.jobs = jobs
        super().__init__(*args, directory=str(jobs.review), **kwargs)

    def trusted_request(self):
        hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        host = self.headers.get('Host')
        origin = self.headers.get('Origin')
        return host in hosts and (origin is None or origin in {'http://' + h for h in hosts})

    def send_json(self, status, value):
        data = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/visibility/status':
            self.send_json(200 if self.trusted_request() else 403,
                           {'available': self.trusted_request(), 'schema_version': 1})
        elif path.startswith('/visibility/jobs/'):
            key = path.removeprefix('/visibility/jobs/')
            job = self.jobs.get(key) if re.fullmatch('[0-9a-f]{64}', key) else None
            self.send_json(403 if not self.trusted_request() else 200 if job else 404,
                           job if self.trusted_request() and job else {'error': 'Job unavailable'})
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != '/visibility/analyze':
            self.send_json(404, {'error': 'Unknown endpoint'})
            return
        if not self.trusted_request():
            self.send_json(403, {'error': 'Local same-origin requests required'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                raise InvalidRequest('Invalid request size')
            payload = json.loads(self.rfile.read(length))
            self.send_json(202, self.jobs.submit(payload))
        except (InvalidRequest, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {'error': str(error)})
        except QueueFull as error:
            self.send_json(429, {'error': str(error)})
        except Exception:
            self.send_json(500, {'error': 'Local analysis inputs are unavailable'})


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('corpus', type=Path)
    p.add_argument('review', type=Path)
    p.add_argument('--port', type=int, default=8769)
    a = p.parse_args()
    jobs = VisibilityJobs(a.corpus, a.review)
    server = ThreadingHTTPServer(('127.0.0.1', a.port), partial(Handler, jobs=jobs))
    print(f'Replay library and visibility service: http://127.0.0.1:{a.port}/library.html', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        jobs.close()


if __name__ == '__main__':
    main()
