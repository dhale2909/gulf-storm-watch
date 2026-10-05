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
MISSING = 1e99
KT = 1.94384
NOW = datetime.now(timezone.utc)


# Same rough boxes as check.mjs.
def in_gulf(lat, lon):
    w = -lon
    return (21.5 <= lat <= 31 and 81 <= w <= 98) or (18 <= lat < 21.5 and 90 <= w <= 98)


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
        json.dump({"updatedAt": NOW.isoformat().replace("+00:00", "Z"), "ensembles": out}, open(OUT, "w"), separators=(",", ":"))
    for e in out:
        print(f"{e['key']}: run {e['run']}, {e['developing']} members with a Gulf track, {e['hits']} reach the coast {e['coast']}, {e['hurricane']} hurricane")


if __name__ == "__main__":
    main()
