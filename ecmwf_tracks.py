#!/usr/bin/env python3
"""European (ECMWF) ensemble cyclone tracks for the Gulf system -> data/ecmwf.json.

Reads the tropical-cyclone track files in ECMWF's open data (CC BY 4.0) for the physics
ensemble (ECENS) and the AI ensemble (AIFS ENS). These include tracks for systems that have
not formed yet, so they cover the disturbance stage. Raw model output, not a forecast:
drawn on the map for context only and never used for alerts.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from statistics import median

import eccodes as ec

OUT = "data/ecmwf.json"
BASE = "https://data.ecmwf.int/forecasts"
ENSEMBLES = [
    # key, label, path, forecast length by cycle hour
    ("ecens", "European ensemble (ECENS)", "ifs/0p25/enfo", {0: 360, 12: 360, 6: 144, 18: 144}),
    ("ecaie", "European AI ensemble (AIFS)", "aifs-ens/0p25/enfo", {0: 360, 6: 360, 12: 360, 18: 360}),
]
MAX_HOURS = 168
VERSION = 2  # bump to force a rebuild of data/ecmwf.json when its shape changes
CELL = 0.25  # swath grid size, degrees
REACH = 0.6  # a member "covers" grid cells within this many degrees of its track
MISSING = 1e99
KT = 1.94384
NOW = datetime.now(timezone.utc)


# Rough boxes, as in check.mjs.
def in_gulf(lat, lon):
    # Starts at 83W, not 81W, so Caribbean or Atlantic systems that only brush Florida are left out.
    w = -lon
    return (21.5 <= lat <= 31 and 83 <= w <= 98) or (18 <= lat < 21.5 and 90 <= w <= 98)


def coast_hit(lat, lon):
    w = -lon
    return (28.5 <= lat <= 36 and 82 <= w <= 93.9) or (24.3 <= lat < 28.5 and 80.8 <= w <= 83.3)


def coast_state(lon):
    w = -lon
    return "LA" if w > 89.5 else "MS" if w > 88.4 else "AL" if w > 87.5 else "FL"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gulf-storm-watch"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def latest_run(path, lengths, have):
    """Newest available cycle in the last 36 hours: (stamp, bytes), or (stamp, None) if we already have it."""
    cycle = NOW.replace(minute=0, second=0, microsecond=0)
    cycle -= timedelta(hours=cycle.hour % 6)
    for _ in range(7):
        stamp = cycle.strftime("%Y%m%d%H")
        if stamp == have:
            return stamp, None
        url = f"{BASE}/{cycle:%Y%m%d}/{cycle:%H}z/{path}/{stamp}0000-{lengths[cycle.hour]}h-enfo-tf.bufr"
        try:
            return stamp, fetch(url)
        except Exception:
            cycle -= timedelta(hours=6)
    return None, None


def arr(h, key, n):
    try:
        v = ec.codes_get_array(h, key)
    except Exception:
        return [None] * n
    v = list(v) if len(v) == n else [v[0]] * n
    return [None if abs(x) > MISSING else float(x) for x in v]


def read_tracks(raw):
    """All Atlantic tracks in a track file: [{member, pts: [(hours, lat, lon, kt)]}]."""
    tmp = "/tmp/_tf.bufr"
    with open(tmp, "wb") as f:
        f.write(raw)
    tracks = []
    with open(tmp, "rb") as f:
        while True:
            h = ec.codes_bufr_new_from_file(f)
            if h is None:
                break
            try:
                ec.codes_set(h, "unpack", 1)
                if not ec.codes_get(h, "stormIdentifier").strip().endswith("L"):
                    continue
                n = ec.codes_get(h, "numberOfSubsets")
                members = arr(h, "ensembleMemberNumber", n)
                periods = 0
                while True:
                    try:
                        ec.codes_get_array(h, f"#{periods + 1}#timePeriod")
                        periods += 1
                    except Exception:
                        break
                pts = [[] for _ in range(n)]
                # Analysis position, then one position per forecast period (layout per ECMWF's track template).
                steps = [(0, 2, 1)] + [(None, i * 2 + 2, i + 1) for i in range(1, periods + 1)]
                for hours, rank, wrank in steps:
                    if hours is None:
                        hours = int(ec.codes_get_array(h, f"#{wrank - 1}#timePeriod")[0])
                    if hours > MAX_HOURS:
                        continue
                    lat, lon = arr(h, f"#{rank}#latitude", n), arr(h, f"#{rank}#longitude", n)
                    wind = arr(h, f"#{wrank}#windSpeedAt10M", n)
                    for m in range(n):
                        if lat[m] is not None and lon[m] is not None:
                            pts[m].append((hours, lat[m], lon[m], round((wind[m] or 0) * KT)))
                for m in range(n):
                    if len(pts[m]) >= 4:
                        tracks.append({"member": int(members[m] or 0), "pts": sorted(pts[m])})
            finally:
                ec.codes_release(h)
    return tracks


def mean_track(gulf, members):
    """Average member position at each forecast hour, wherever enough members have a storm at that hour."""
    by_hour = {}
    for t in gulf:
        for hours, la, lo, _ in t["pts"]:
            by_hour.setdefault(hours, {}).setdefault(t["member"], (la, lo))
    need = max(5, 0.4 * members)
    line = []
    for hours in sorted(by_hour):
        pos = list(by_hour[hours].values())
        if len(pos) >= need:
            line.append([round(sum(p[1] for p in pos) / len(pos), 1), round(sum(p[0] for p in pos) / len(pos), 1)])
    if len(line) < 3:
        return None
    # Light smoothing: membership changes hour to hour, which makes the raw average wobble.
    return [line[0]] + [[round((a[0] + b[0] + c[0]) / 3, 1), round((a[1] + b[1] + c[1]) / 3, 1)] for a, b, c in zip(line, line[1:], line[2:])] + [line[-1]]


def swaths(gulf, members):
    """Where the members go: grid cells crossed by at least 25% and 50% of them, as row-merged rectangles."""
    cover = {}
    for t in gulf:
        pts = t["pts"]
        for a, b in zip(pts, pts[1:]):
            steps = max(1, int(max(abs(b[1] - a[1]), abs(b[2] - a[2])) / 0.1))
            for k in range(steps + 1):
                la, lo = a[1] + (b[1] - a[1]) * k / steps, a[2] + (b[2] - a[2]) * k / steps
                r = int(REACH / CELL) + 1
                ci, cj = int(lo // CELL), int(la // CELL)
                for i in range(ci - r, ci + r + 1):
                    for j in range(cj - r, cj + r + 1):
                        if ((i + 0.5) * CELL - lo) ** 2 + ((j + 0.5) * CELL - la) ** 2 <= REACH ** 2:
                            cover.setdefault((i, j), set()).add(t["member"])
    out = []
    for level in (25, 50):
        rows = {}
        for (i, j), who in cover.items():
            if len(who) >= members * level / 100:
                rows.setdefault(j, []).append(i)
        rects = []
        for j, cols in rows.items():
            cols.sort()
            start = prev = cols[0]
            for i in cols[1:] + [None]:
                if i is None or i != prev + 1:
                    x0, x1, y0, y1 = start * CELL, (prev + 1) * CELL, j * CELL, (j + 1) * CELL
                    rects.append([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]])
                    start = i
                prev = i
        if rects:
            out.append((level, rects))
    return out


def summarize(key, label, stamp, tracks):
    init = datetime.strptime(stamp, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    gulf = [t for t in tracks if any(in_gulf(la, lo) for _, la, lo, _ in t["pts"])]
    coast = {"LA": 0, "MS": 0, "AL": 0, "FL": 0}
    etas, peaks, seen, features = [], [], set(), []
    for t in gulf:
        hit = next((p for p in t["pts"] if coast_hit(p[1], p[2])), None)
        peak = max(p[3] for p in t["pts"])
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[round(lo, 1), round(la, 1)] for _, la, lo, _ in t["pts"]]},
            "properties": {"role": "ec", "ens": key, "member": t["member"], "peak": peak},
        })
        if t["member"] in seen:  # a member can carry more than one Gulf track; count it once
            continue
        seen.add(t["member"])
        peaks.append(peak)
        if hit:
            coast[coast_state(hit[2])] += 1
            etas.append(hit[0])
    # Cleaner default view: one average line and a shaded swath; member lines stay available behind a switch.
    mean = mean_track(gulf, len(seen))
    if mean:
        features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": mean}, "properties": {"role": "ecmean", "ens": key, "members": len(seen)}})
    for level, rects in swaths(gulf, len(seen)):
        features.append({"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": rects}, "properties": {"role": "ecswath", "ens": key, "level": level}})
    return {
        "key": key, "label": label, "run": init.isoformat().replace("+00:00", "Z"),
        "developing": len(seen), "hits": len(etas), "coast": coast,
        "eta": (init + timedelta(hours=median(etas))).isoformat().replace("+00:00", "Z") if etas else None,
        "hurricane": sum(1 for p in peaks if p >= 64),
        "features": features,
    }


def main():
    try:
        prior = json.load(open(OUT))
    except Exception:
        prior = {"ensembles": []}
    if prior.get("version") != VERSION:
        prior = {"ensembles": []}
    old = {e["key"]: e for e in prior.get("ensembles", [])}
    out, changed = [], False
    for key, label, path, lengths in ENSEMBLES:
        have = old.get(key, {}).get("run", "")
        have_stamp = have[:13].replace("-", "").replace("T", "") if have else None
        try:
            stamp, raw = latest_run(path, lengths, have_stamp)
            if raw is None:  # nothing newer (or nothing reachable): keep what we have
                if key in old:
                    out.append(old[key])
                continue
            out.append(summarize(key, label, stamp, read_tracks(raw)))
            changed = True
        except Exception as e:  # never let this optional layer break the check
            print(f"{key}: unavailable ({e})", file=sys.stderr)
            if key in old:
                out.append(old[key])
    if changed:
        os.makedirs("data", exist_ok=True)
        json.dump({"version": VERSION, "updatedAt": NOW.isoformat().replace("+00:00", "Z"), "ensembles": out}, open(OUT, "w"), separators=(",", ":"))
    for e in out:
        print(f"{e['key']}: run {e['run']}, {e['developing']} members with a Gulf track, {e['hits']} reach the coast {e['coast']}, {e['hurricane']} hurricane")


if __name__ == "__main__":
    main()
