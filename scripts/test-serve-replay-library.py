"""Exercise native job identity, cache invalidation, failures and HTTP boundaries."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('replay_server', Path(__file__).with_name('serve-replay-library.py'))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='visibility-service-test-', dir=server.ROOT / '.local')
        self.root = Path(self.temp.name)
        self.export = self.root / 'export'
        self.export.mkdir()
        (self.export / 'manifest.json').write_text(json.dumps({'duration_ms': 10000,
            'players': [{'subject': 'a'}, {'subject': 'b'}]}))
        (self.export / 'movement.parquet').write_bytes(b'movement')
        (self.export / 'fields.parquet').write_bytes(b'fields')
        (self.export / 'actors.parquet').write_bytes(b'actors')
        (self.export / 'net_guids.parquet').write_bytes(b'net guids')
        self.corpus = self.root / 'corpus.json'
        self.corpus.write_text(json.dumps({'replays': [{'match_id': 'match', 'status': 'validated',
            'export': str(self.export)}]}))
        directory = self.root / 'library' / 'match'
        directory.mkdir(parents=True)
        (directory / 'replay.json').write_text('{}')
        (directory / 'viewer.html').write_text('viewer')
        # Changes to input fixtures must never touch the actual library or
        # helper sources used by another active analysis.
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in server.SOURCE_FILES:
            (scripts / name).write_text('fixture ' + name)
        self.root_patch = patch.object(server, 'ROOT', self.root)
        self.root_patch.start()
        self.calls = []
        self.jobs = server.VisibilityJobs(self.corpus, self.root, runner=self.run_fake)
        self.request = {'match_id': 'match', 'observer': 'a', 'target': 'b', 'start_ms': 10, 'end_ms': 1000}

    def tearDown(self):
        self.jobs.close()
        self.root_patch.stop()
        self.temp.cleanup()

    def run_fake(self, request, path):
        self.calls.append(request)
        path.write_text(json.dumps({**request, 'window_ms': [request['start_ms'], request['end_ms']],
            'display_models': {'smoke': request['smoke'], 'crouch': request['crouch']}, 'samples': []}))

    def finish(self):
        # A marker queued after the submitted job observes its completion.
        self.jobs.pool.submit(lambda: None).result(timeout=5)

    def test_rejects_foreign_subjects_clocks_and_options(self):
        for change in ({'match_id': '../foreign'}, {'target': 'a'}, {'target': 'P2'},
                       {'start_ms': True}, {'end_ms': 10000}, {'crouch': 'false'}, {'extra': 1}):
            with self.subTest(change=change), self.assertRaises(server.InvalidRequest):
                self.jobs.submit({**self.request, **change})
        self.assertEqual(self.calls, [])

    def test_duplicates_and_restart_reuse_only_valid_cache(self):
        first = self.jobs.submit(self.request)
        self.assertEqual(self.jobs.submit(self.request)['id'], first['id'])
        self.finish()
        self.assertEqual(len(self.calls), 1)
        self.jobs.jobs.clear()
        self.assertEqual(self.jobs.submit(self.request)['status'], 'complete')
        path = self.jobs.results / (first['id'] + '.json')
        path.write_text('{truncated')
        self.jobs.jobs.clear()
        self.jobs.submit(self.request)
        self.finish()
        self.assertEqual(len(self.calls), 2)

    def test_sources_pair_direction_and_options_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        key = self.jobs.signature(payload)
        self.assertNotEqual(key, self.jobs.signature({**payload, 'observer': 'b', 'target': 'a'}))
        self.assertNotEqual(key, self.jobs.signature({**payload, 'smoke': False}))
        (self.export / 'movement.parquet').write_bytes(b'new movement')
        self.assertNotEqual(key, self.jobs.signature(payload))
        key = self.jobs.signature(payload)
        inputs = self.root / 'visibility-inputs'
        inputs.mkdir()
        (inputs / 'match.json').write_text('{"new_camera_evidence":true}')
        self.assertNotEqual(key, self.jobs.signature(payload))

    def input_file(self, relative, content='{}'):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_new_helpers_and_native_guid_source_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        paths = [self.root / 'scripts' / name for name in (
            'replay_smoke_profiles.py', 'replay_ability_occluders.py', 'replay_dynamic_occluders.py')]
        paths.append(self.export / 'net_guids.parquet')
        for path in paths:
            with self.subTest(path=path.name):
                before = self.jobs.signature(payload)
                path.write_bytes(path.read_bytes() + b' changed fixture')
                self.assertNotEqual(before, self.jobs.signature(payload))

    def test_addon_presence_content_and_removal_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        prefix = '.local/replay-transcripts/'
        inputs = [
            'visibility-inputs/match.json',
            'ability-occluder-inputs-v1/match.json',
            prefix + 'asset-research/visibility-effects-v1/rules.json',
            prefix + 'asset-research/visibility-smoke-profiles-v1/smoke-model.json',
            prefix + 'asset-research/visibility-smoke-profiles-v1/source.json',
            prefix + 'asset-research/visibility-smoke-profiles-v1/replays/match.json',
            prefix + 'corpus-asset-model.json',
            prefix + 'asset-research/ability-occluders-v1/model.json',
            prefix + 'asset-research/dynamic-map-assets-v3.json',
            prefix + 'asset-research/dynamic-map-replay-evidence-v3/index.json',
            prefix + 'asset-research/dynamic-map-replay-evidence-v3/match.json',
        ]
        for relative in inputs:
            with self.subTest(input=relative):
                absent = self.jobs.signature(payload)
                path = self.input_file(relative)
                present = self.jobs.signature(payload)
                self.assertNotEqual(absent, present)
                path.write_text('{"changed":true}')
                changed = self.jobs.signature(payload)
                self.assertNotEqual(present, changed)
                path.unlink()
                self.assertEqual(absent, self.jobs.signature(payload))

    def test_smoke_provenance_source_paths_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        source = self.input_file('custom-smoke-source.json')
        canonical = self.input_file('custom-canonical-model.json')
        self.input_file('.local/replay-transcripts/asset-research/visibility-smoke-profiles-v1/smoke-model.json',
            json.dumps({'source_provenance': {'source_json_file': str(source), 'canonical_model_file': str(canonical)}}))
        for path in (source, canonical):
            before = self.jobs.signature(payload)
            path.write_text(path.read_text() + ' ')
            self.assertNotEqual(before, self.jobs.signature(payload))

    def test_dynamic_asset_source_receipts_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        source = self.input_file('.local/replay-transcripts/asset-research/installed-behavior-source-v5/class.json.gz')
        manifest = self.input_file('.local/replay-transcripts/asset-research/installed-behavior-source-v5/manifest.json')
        self.input_file('.local/replay-transcripts/asset-research/dynamic-map-assets-v3.json',
            json.dumps({'class_records': [{'receipt': {'file': source.name}}]}))
        for path in (source, manifest):
            before = self.jobs.signature(payload)
            path.write_bytes(path.read_bytes() + b' changed')
            self.assertNotEqual(before, self.jobs.signature(payload))

    def test_native_camera_shader_source_receipts_invalidate_cache(self):
        payload = self.jobs.validate(self.request)
        prefix = '.local/replay-transcripts/asset-research/'
        source = self.input_file(prefix + 'installed-behavior-source-v5/widget.json.gz')
        manifest = self.input_file(prefix + 'installed-behavior-source-v5/manifest.json')
        index = self.input_file(prefix + 'installed-behavior-source-v5/index.jsonl')
        bindings = self.input_file(prefix + 'native-visibility-bindings-v1/bindings.json',
            json.dumps({'sources': {'widget': {'file': source.name}}}))
        for path in (source, manifest, index, bindings):
            before = self.jobs.signature(payload)
            path.write_bytes(path.read_bytes() + b' ')
            self.assertNotEqual(before, self.jobs.signature(payload))

    def test_other_replay_sidecars_do_not_invalidate_this_encounter(self):
        payload = self.jobs.validate(self.request)
        before = self.jobs.signature(payload)
        for relative in ('ability-occluder-inputs-v1/other.json',
            '.local/replay-transcripts/asset-research/visibility-smoke-profiles-v1/replays/other.json',
            '.local/replay-transcripts/asset-research/dynamic-map-replay-evidence-v3/other.json'):
            self.input_file(relative)
        self.assertEqual(before, self.jobs.signature(payload))

    def test_completed_cache_is_rerun_after_addon_change(self):
        first = self.jobs.submit(self.request)
        self.finish()
        self.assertEqual(self.jobs.get(first['id'])['status'], 'complete')
        self.jobs.jobs.clear()
        self.assertEqual(self.jobs.submit(self.request)['status'], 'complete')
        self.assertEqual(len(self.calls), 1)
        self.input_file('ability-occluder-inputs-v1/match.json', '{"new_activation_evidence":true}')
        second = self.jobs.submit(self.request)
        self.finish()
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(self.jobs.get(second['id'])['status'], 'complete')
        self.assertEqual(len(self.calls), 2)

    def test_same_bytes_in_different_optional_roles_do_not_alias_cache(self):
        payload = self.jobs.validate(self.request)
        camera = self.input_file('visibility-inputs/match.json', '{"same":true}')
        camera_key = self.jobs.signature(payload)
        camera.unlink()
        self.input_file('ability-occluder-inputs-v1/match.json', '{"same":true}')
        self.assertNotEqual(camera_key, self.jobs.signature(payload))

    def test_jam_overlay_and_base_remain_bound_with_dynamic_assets(self):
        self.jobs.records['match']['map_path'] = '/Game/Maps/Jam/Jam'
        payload = self.jobs.validate(self.request)
        self.input_file('.local/replay-transcripts/asset-research/dynamic-map-assets-v3.json',
            '{"class_records":[{"receipt":{"file":"class.json.gz"}}]}')
        for directory in ('map-Jam-static-art-overlay-v1', 'map-Jam-13.06'):
            for name in ('map.json', 'geometry.npz'):
                before = self.jobs.signature(payload)
                self.input_file('.local/replay-transcripts/' + directory + '/' + name)
                self.assertNotEqual(before, self.jobs.signature(payload))

    def test_input_change_during_job_cannot_be_cached_as_the_old_sources(self):
        started, release = threading.Event(), threading.Event()
        def blocked(request, path):
            started.set()
            release.wait(5)
            self.run_fake(request, path)
        self.jobs.runner = blocked
        first = self.jobs.submit(self.request)
        try:
            self.assertTrue(started.wait(5))
            (self.export / 'net_guids.parquet').write_bytes(b'changed native GUID ownership')
        finally:
            release.set()
        self.finish()
        self.assertEqual(self.jobs.get(first['id'])['status'], 'failed')
        self.assertFalse((self.jobs.results / (first['id'] + '.json')).exists())
        second = self.jobs.submit(self.request)
        self.finish()
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(self.jobs.get(second['id'])['status'], 'complete')

    def test_queue_failure_and_retry(self):
        release = threading.Event()
        def blocked(request, path):
            release.wait(5)
            self.run_fake(request, path)
        self.jobs.runner = blocked
        self.jobs.max_pending = 1
        first = self.jobs.submit(self.request)
        try:
            with self.assertRaises(server.QueueFull):
                self.jobs.submit({**self.request, 'end_ms': 2000})
        finally:
            release.set()
        self.finish()
        self.assertEqual(self.jobs.get(first['id'])['status'], 'complete')
        def wrong(request, path):
            self.run_fake({**request, 'observer': 'wrong'}, path)
        self.jobs.runner = wrong
        second = self.jobs.submit({**self.request, 'end_ms': 3000})
        self.finish()
        self.assertEqual(self.jobs.get(second['id'])['status'], 'failed')
        self.assertFalse((self.jobs.results / (second['id'] + '.json')).exists())
        self.jobs.runner = self.run_fake
        self.jobs.submit({**self.request, 'end_ms': 3000})
        self.finish()
        self.assertEqual(self.jobs.get(second['id'])['status'], 'complete')

    def test_http_rejects_foreign_origin_and_invalid_size(self):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), partial(server.Handler, jobs=self.jobs))
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        def post(headers, body='{}'):
            conn = HTTPConnection('127.0.0.1', http.server_port, timeout=5)
            conn.request('POST', '/visibility/analyze', body, headers)
            response = conn.getresponse()
            result = response.status, response.read()
            conn.close()
            return result
        try:
            self.assertEqual(post({'Origin': 'https://foreign.example'})[0], 403)
            self.assertEqual(post({}, 'x' * 4097)[0], 400)
            self.assertEqual(post({}, json.dumps(self.request))[0], 202)
            self.finish()
            self.assertEqual(len(self.calls), 1)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
