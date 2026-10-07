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
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from statistics import median

OUT = "data/ecmwf.json"
BASE = "https://data.ecmwf.int/forecasts"
ENSEMBLES = [
    # key, label, path, forecast length by cycle hour
    ("ecens", "European ensemble (ECENS)", "ifs/0p25/enfo", {0: 360, 12: 360, 6: 144, 18: 144}),
    ("ecaie", "European AI ensemble (AIFS)", "aifs-ens/0p25/enfo", {0: 360, 6: 360, 12: 360, 18: 360}),
]
MAX_HOURS = 168
VERSION = 7  # bump to force a rebuild of data/ecmwf.json when its shape or method changes
CELL = 0.25  # swath grid size, degrees
REACH = 0.6  # a member "covers" grid cells within this many degrees of its track
MISSING = 1e99
KT = 1.94384
NOW = datetime.now(timezone.utc)
# One wall-clock budget for every download: a stalled server must not hold up the share card or the Mac's next check.
DEADLINE = time.monotonic() + float(os.environ.get("ECMWF_BUDGET", 150))


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
    left = DEADLINE - time.monotonic()
    if left < 5:
        raise TimeoutError("time budget used up")
    req = urllib.request.Request(url, headers={"User-Agent": "gulf-storm-watch"})
    with urllib.request.urlopen(req, timeout=min(60, left)) as r:
        chunks = []
        while True:
            if time.monotonic() > DEADLINE:  # the socket timeout bounds each read, not a slow trickle
                raise TimeoutError("time budget used up")
            b = r.read(1 << 16)
            if not b:
                return b"".join(chunks)
            chunks.append(b)


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
        except urllib.error.HTTPError:  # not published (yet): try the cycle before
            cycle -= timedelta(hours=6)
        # Anything else (a stall, the budget, no network) is not "not published": stop and keep what we have,
        # rather than quietly publishing an older run as the latest.
    return None, None


def arr(h, key, n):
    try:
        v = ec.codes_get_array(h, key)
    except Exception:
        return [None] * n
    v = list(v) if len(v) == n else [v[0]] * n
    return [None if abs(x) > MISSING else float(x) for x in v]


def read_tracks(raw):
    """All tracks in a track file: [{member, pts: [(hours, lat, lon, kt)]}]."""
    global ec
    import eccodes as ec  # here, so the track logic below can be tested without eccodes installed

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
                # No filtering by identifier: ECMWF files this system under an East Pacific-style label ("72E")
                # even though it sits in the Bay of Campeche. Geography decides below.
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


def merge_members(tracks):
    """One track per member and system. ECMWF files the same storm under several identifiers ("09L", "72E", "71L"),
    often with one copy cut short: copies that agree (within a degree at every common hour) are joined hour by hour,
    the longest copy's position winning. A member's genuinely different system stays a separate track."""
    out = []
    for member in sorted({t["member"] for t in tracks}):
        merged = []
        for t in sorted((t for t in tracks if t["member"] == member), key=lambda t: -len(t["pts"])):
            for m in merged:
                common = [p for p in t["pts"] if p[0] in m]
                if common and all(abs(m[p[0]][1] - p[1]) <= 1 and abs(m[p[0]][2] - p[2]) <= 1 for p in common):
                    for p in t["pts"]:
                        m.setdefault(p[0], p)
                    break
            else:
                merged.append({p[0]: p for p in t["pts"]})
        out += [{"member": member, "pts": sorted(m.values())} for m in merged]
    return out


def mean_track(gulf, members):
    """Typical member position (median) at each forecast hour, while most members still have a storm.

    A member whose track has ended (landfall, or the model losing the system over water) is held at its
    last position, so the median is not dragged around by whichever members happen to remain. The line
    ends once fewer than 60% of the members still have the storm: held positions keep the median steady,
    but they are not forecasts, so they never extend the line.
    """
    by_hour, live = {}, {}
    last_hour = max(t["pts"][-1][0] for t in gulf) if gulf else 0
    for t in gulf:
        for hours, la, lo, _ in t["pts"]:
            by_hour.setdefault(hours, {}).setdefault(t["member"], (la, lo))
            live.setdefault(hours, set()).add(t["member"])
        end = t["pts"][-1]
        for hours in range(end[0] + 6, last_hour + 1, 6):
            by_hour.setdefault(hours, {}).setdefault(t["member"], (end[1], end[2]))
    need = max(5, 0.6 * members)
    line, kept = [], []
    for hours in sorted(by_hour):
        if len(live.get(hours, ())) < need:
            break
        pos = list(by_hour[hours].values())
        line.append([round(median(p[1] for p in pos), 1), round(median(p[0] for p in pos), 1)])
        kept.append(hours)
    if len(line) < 3:
        return None, None
    # Light smoothing: membership changes hour to hour, which makes the raw average wobble.
    smooth = [line[0]] + [[round((a[0] + b[0] + c[0]) / 3, 1), round((a[1] + b[1] + c[1]) / 3, 1)] for a, b, c in zip(line, line[1:], line[2:])] + [line[-1]]
    return smooth, kept  # kept: forecast hour of each point, so the line can be lined up with other tracks by time


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
    # Our system: tracks that start in the Gulf (a wave that only enters later is a different system).
    gulf = merge_members([t for t in tracks if in_gulf(t["pts"][0][1], t["pts"][0][2])])
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
    mean, hours = mean_track(gulf, len(seen))
    if mean:
        features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": mean}, "properties": {"role": "ecmean", "ens": key, "members": len(seen), "hours": hours}})
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
