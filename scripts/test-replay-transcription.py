"""Checks for the time/angle and geometry boundaries used in replay review."""
import math
import struct
import unittest

import numpy as np

from replay_transcription import MeshBVH, angular_distance, pose, rapid_turn, static_sightline


class GeometryTests(unittest.TestCase):
    def wall(self, x):
        return [[x, -100, -100], [x, 100, -100], [x, 0, 150]]

    def test_nearest_hit_not_first_triangle(self):
        mesh = MeshBVH([self.wall(80), self.wall(20)], leaf_size=1)
        self.assertTrue(np.allclose(mesh.hit([0, 0, 0], [100, 0, 0]), [20, 0, 0]))

    def test_parallel_and_outside_rays_clear(self):
        mesh = MeshBVH([self.wall(20)])
        self.assertIsNone(mesh.hit([0, 0, 0], [0, 100, 0]))
        self.assertIsNone(mesh.hit([0, 400, 0], [100, 400, 0]))

    def test_endpoint_contacts_do_not_become_walls(self):
        mesh = MeshBVH([self.wall(100)])
        self.assertIsNone(mesh.hit([0, 0, 0], [100, 0, 0]))

    def test_partial_body_is_mixed(self):
        triangle = [[50, -100, -100], [50, 100, -100], [50, 0, 40]]
        mesh = MeshBVH([triangle])
        a = np.array([0, 0, 0, 0, 0, 0, 0.])
        b = np.array([0, 100, 0, 0, 0, 0, 0.])
        self.assertEqual(static_sightline(mesh, a, b)["status"], "mixed")

    def test_binary_layout(self):
        mesh = MeshBVH([self.wall(20)])
        raw = mesh.binary()
        self.assertEqual(raw[:4], b"VRBV")
        nodes, triangles, version = struct.unpack("<III", raw[4:16])
        self.assertEqual(version, 1)
        self.assertEqual(len(raw), 16+nodes*40+triangles*36)


class MovementTests(unittest.TestCase):
    def test_wrap_and_vertical_look(self):
        self.assertAlmostEqual(angular_distance(359, 0, 1, 0), 2)
        self.assertAlmostEqual(angular_distance(0, 89, 180, 89), 2)

    def test_future_and_stale_samples_unavailable(self):
        track = np.array([[100, 0, 0, 0, 0, 0, 0], [200, 0, 0, 0, 0, 0, 0.]])
        self.assertIsNone(pose(track, 99))
        self.assertIsNone(pose(track, 301))
        self.assertEqual(pose(track, 150)[0], 100)

    def tracks(self):
        times = np.arange(0, 505, 8.)
        yaw = 73*(1-np.clip((times-200)/100, 0, 1))
        observer = np.column_stack([times, np.zeros((len(times), 3)), yaw, np.zeros((len(times), 2))])
        target = np.column_stack([times, np.full(len(times), 1000), np.zeros(len(times)), np.full(len(times), 77), np.zeros((len(times), 3))])
        return observer, target

    def test_native_turn_candidate_toward_killed_target(self):
        observer, target = self.tracks()
        turn = rapid_turn(observer, target, 400, 0)
        self.assertIsNotNone(turn)
        self.assertGreater(turn["angle_deg"], 65)
        self.assertLessEqual(turn["duration_ms"], 100)

    def test_round_boundary_and_gaps_do_not_create_turns(self):
        observer, target = self.tracks()
        self.assertIsNone(rapid_turn(observer, target, 400, 350))
        gapped = observer[(observer[:, 0] < 210) | (observer[:, 0] > 290)]
        self.assertIsNone(rapid_turn(gapped, target, 400, 0))


if __name__ == "__main__":
    unittest.main()
