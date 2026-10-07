"""Regression tests for ecmwf_tracks.py (F66, F67, F71). Run: python3 -m unittest discover -s test -p 'test_*.py'
No network and no eccodes needed: only the track logic is exercised."""
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ecmwf_tracks as e  # noqa: E402


def track(member, last_hour, lat0=22.0, lon0=-92.0):
    return {"member": member, "pts": [(h, lat0 + h / 24, lon0 + h / 48, 40) for h in range(0, last_hour + 1, 6)]}


class MergeMembers(unittest.TestCase):
    def test_copies_of_one_storm_under_several_identifiers_become_one_track(self):
        short, longer = track(2, 48), track(2, 96)  # e.g. "09L" cut at 48 h, "71L" to 96 h
        merged = e.merge_members([short, dict(short), longer])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["pts"][-1][0], 96)

    def test_a_different_system_for_the_same_member_stays_separate(self):
        merged = e.merge_members([track(3, 48), track(3, 48, lat0=26.0, lon0=-85.0)])
        self.assertEqual(len(merged), 2)

    def test_counts_and_member_lines_use_each_member_once(self):
        tracks = [track(m, 48) for m in range(6)] + [dict(track(m, 48)) for m in range(6)]
        s = e.summarize("ecaie", "AIFS", "2026100700", tracks)
        self.assertEqual(s["developing"], 6)
        self.assertEqual(sum(1 for f in s["features"] if f["properties"]["role"] == "ec"), 6)


class MeanTrack(unittest.TestCase):
    def test_line_ends_once_most_members_have_finished(self):
        gulf = [track(m, 72) for m in range(9)] + [track(9, 168)]
        line, hours = e.mean_track(gulf, 10)
        self.assertEqual(hours[-1], 72)
        self.assertEqual(len(line), len(hours))


class Downloads(unittest.TestCase):
    def setUp(self):
        self.fetch = e.fetch

    def tearDown(self):
        e.fetch = self.fetch

    def test_unpublished_cycles_fall_back_to_earlier_ones(self):
        calls = []

        def not_found(url):
            calls.append(url)
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        e.fetch = not_found
        self.assertEqual(e.latest_run("p", {0: 360, 6: 144, 12: 360, 18: 144}, None), (None, None))
        self.assertEqual(len(calls), 7)

    def test_a_stall_is_not_mistaken_for_an_unpublished_cycle(self):
        calls = []

        def stall(url):
            calls.append(url)
            raise TimeoutError("time budget used up")

        e.fetch = stall
        with self.assertRaises(TimeoutError):
            e.latest_run("p", {0: 360, 6: 144, 12: 360, 18: 144}, None)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
