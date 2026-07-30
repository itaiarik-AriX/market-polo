#!/usr/bin/env python3
"""Generate the survey chart of Galicia used by the intro.

Produces `src/lib/galiciaChart.ts`: contour paths plus the pinned summits.

Why it is built rather than drawn: the coastline is real (four province
boundaries), the summits are real, and the relief between them is derived from
those summits — so a pin and the contour under it agree. An earlier version
derived contours from distance-to-coastline alone, which put "summits" wherever
Galicia happened to be widest; pinning real mountains on that would have marked
terrain that does not exist.

Pipeline, with the parts that are load-bearing flagged:

  geojson -> rasterise all four provinces into ONE mask (their union comes free,
             no polygon-boolean library needed; shapely is not available), and
             ALL of Spain into a second mask, purely to know which parts of the
             outline are coast and which are the land border.
          -> chamfer 3-4 distance transform from the OCEAN, signed. 4-neighbour
             erosion instead gives Manhattan diamonds, not terrain.
          -> elevation = 0.85 x (rise away from the coast, flattened above 0.60
                                 of its range)
                       + 0.60 x (Gaussian per massif, scaled by its height)
             The two terms split the province between them: the ramp draws the
             west, where there are no summits to draw it, and goes level across
             the eastern uplands so the peaks shape the ground there. One term
             alone cannot do both — see the two failure modes below.
          -> light blur only. Heavier smoothing erases the rias, which are the
             most recognisable thing about this coast.
          -> marching squares at levels spaced (k/15)^0.78, denser on low
             ground. Even spacing puts nearly every line around the summits.
          -> clip the traced lines to Galicia, so contours run off the eastern
             border and stop rather than being crushed into it.
          -> Chaikin, then per-ring RDP (tolerance scaled to ring perimeter: one
             global epsilon flattens small loops into visible polygons)
          -> Catmull-Rom fitted to cubic Beziers. Straight segments look faceted
             however many points are kept.

Two failure modes this has already been through, both visible on a phone:

  * Measuring the rise from the whole OUTLINE treats the land border as
    shoreline. Pena Trevinca stands on that border, so all 2127m had to fall
    away within ~12 units of it: fourteen contour levels inside 12 CSS pixels,
    merged into one dark smear. Measured: 10 of 15 gaps below 2px, the tightest
    0.07px.
  * Measuring from the ocean alone fixes the smear but makes the field a smooth
    west-to-east ramp, whose level sets are parallel bands. The summits vanish
    and the map reads as stripes. Hence the cap, which is what keeps both.

The silhouette is traced from the land mask itself, not from the zero crossing:
with a field that stays high at the border there is no zero crossing on the
eastern side, and the outline would have been left open.

The field is computed on a PADDED canvas and cropped. Computed at the visible
size, the offshore distance is clipped by the raster border and leaves dense
scribble artifacts along every edge.

Data source (the only external host reachable from the build environment):
https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/spain-provinces.geojson

Usage:  python3 scripts/make-galicia-chart.py [--geojson PATH]
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

GEOJSON_URL = ('https://raw.githubusercontent.com/codeforgermany/click_that_hood'
               '/main/public/data/spain-provinces.geojson')
PROVINCES = {'A Coruña', 'Lugo', 'Ourense', 'Pontevedra'}
OUT = 'src/lib/galiciaChart.ts'

SC = 2                      # field is computed at half the emitted resolution
VW, VH = 900 // SC, 620 // SC
PADX, PADY = 150, 110
W, H = VW + 2 * PADX, VH + 2 * PADY

# Coordinates and elevations supplied by the site owner. Pena Negra (2121 m) and
# Pena Surbia (2116 m) are in the same list but omitted: both sit inside the
# Macizo de Trevinca within ~0.02 deg of Pena Trevinca, about 4px here, so they
# cannot be pinned as distinct marks.
PEAKS = [
    ('Pena Trevinca',       42.2642, -6.7933, 2127),   # Serra do Eixe
    ('Pico O Mostallar',    42.8225, -6.8425, 1935),   # Serra dos Ancares
    ('Cabeza de Manzaneda', 42.2570, -7.2980, 1781),   # Macizo Central Ourensan
]
MAX_ELEV = max(p[3] for p in PEAKS)
# Mostallar straddles the Lugo/Leon border, so it samples just outside the
# rasterised polygon and its mark sits on the outline. That is correct.

# 15, not 17. The count is a legibility budget as much as a style choice: at 17
# the saddle west of Manzaneda closed to 0.50px between lines, which renders as
# one thick stroke. Measured across all three summits, 17 left 6 sub-2px gaps
# and 15 leaves 1, at 1.72px. Below 15 it gets worse again, not better.
N_LAND_LEVELS = 15


def load_rings(path, names=None, want=0):
    """Outer rings of the named provinces, or of every province if names is None."""
    d = json.load(open(path, encoding='utf-8'))
    rings = []
    for f in d['features']:
        if names is not None and f['properties'].get('name') not in names:
            continue
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for poly in polys:
            if len(poly[0]) > 40:
                rings.append(poly[0])
    if want and len(rings) < want:
        sys.exit(f'expected {want} province rings, found {len(rings)}')
    return rings


def chamfer(mask_rows):
    """Two-pass chamfer 3-4. Plain lists: numpy scalar indexing is far slower."""
    INF = 10 ** 7
    a = [[INF if mask_rows[y][x] else 0 for x in range(W)] for y in range(H)]
    for y in range(H):
        ay = a[y]
        ap = a[y - 1] if y else None
        for x in range(W):
            v = ay[x]
            if v == 0:
                continue
            if x:
                v = min(v, ay[x - 1] + 3)
            if ap is not None:
                v = min(v, ap[x] + 3)
                if x:
                    v = min(v, ap[x - 1] + 4)
                if x + 1 < W:
                    v = min(v, ap[x + 1] + 4)
            ay[x] = v
    for y in range(H - 1, -1, -1):
        ay = a[y]
        an = a[y + 1] if y + 1 < H else None
        for x in range(W - 1, -1, -1):
            v = ay[x]
            if v == 0:
                continue
            if x + 1 < W:
                v = min(v, ay[x + 1] + 3)
            if an is not None:
                v = min(v, an[x] + 3)
                if x + 1 < W:
                    v = min(v, an[x + 1] + 4)
                if x:
                    v = min(v, an[x - 1] + 4)
            ay[x] = v
    return np.array(a, dtype=np.float32) / 3.0


def blur(a, r, n):
    k = np.ones(2 * r + 1, np.float32) / (2 * r + 1)
    for _ in range(n):
        a = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), 0, a)
        a = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), 1, a)
    return a


def marching(f, level):
    H_, W_ = f.shape
    g = f >= level

    def ip(p1, p2, v1, v2):
        t = 0.5 if v1 == v2 else (level - v1) / (v2 - v1)
        return (p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t)

    T = {1: [(2, 3)], 2: [(1, 2)], 3: [(1, 3)], 4: [(0, 1)], 5: [(0, 3), (1, 2)],
         6: [(0, 2)], 7: [(0, 3)], 8: [(0, 3)], 9: [(0, 2)], 10: [(0, 1), (2, 3)],
         11: [(0, 1)], 12: [(1, 3)], 13: [(1, 2)], 14: [(2, 3)]}
    corners = (g[:-1, :-1], g[:-1, 1:], g[1:, 1:], g[1:, :-1])
    active = np.argwhere((corners[0] | corners[1] | corners[2] | corners[3]) &
                         ~(corners[0] & corners[1] & corners[2] & corners[3]))
    segs = []
    for y, x in active:
        c = ((int(g[y, x]) << 3) | (int(g[y, x + 1]) << 2)
             | (int(g[y + 1, x + 1]) << 1) | int(g[y + 1, x]))
        v = [f[y, x], f[y, x + 1], f[y + 1, x + 1], f[y + 1, x]]
        P = [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]
        e = {0: ip(P[0], P[1], v[0], v[1]), 1: ip(P[1], P[2], v[1], v[2]),
             2: ip(P[2], P[3], v[2], v[3]), 3: ip(P[3], P[0], v[3], v[0])}
        for a, b in T.get(c, []):
            segs.append((e[a], e[b]))

    key = lambda p: (round(p[0], 1), round(p[1], 1))
    adj = {}
    for a, b in segs:
        adj.setdefault(key(a), []).append((a, b))
        adj.setdefault(key(b), []).append((b, a))
    used, lines = set(), []
    for a, b in segs:
        if (key(a), key(b)) in used or (key(b), key(a)) in used:
            continue
        line = [a, b]
        used.add((key(a), key(b)))
        while True:
            nxt = None
            for p, q in adj.get(key(line[-1]), []):
                if (key(p), key(q)) in used or (key(q), key(p)) in used:
                    continue
                nxt = (p, q)
                break
            if not nxt:
                break
            used.add((key(nxt[0]), key(nxt[1])))
            line.append(nxt[1])
            if key(line[-1]) == key(line[0]):
                break
        if len(line) > 22:
            lines.append(line)
    return lines


def chaikin(pl, n=2):
    for _ in range(n):
        o = [pl[0]]
        for i in range(len(pl) - 1):
            p, q = pl[i], pl[i + 1]
            o.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            o.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        o.append(pl[-1])
        pl = o
    return pl


def rdp(pts, eps):
    if len(pts) < 3:
        return pts

    def d2(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == dy == 0:
            return (x - x1) ** 2 + (y - y1) ** 2
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2

    st, keep = [(0, len(pts) - 1)], [False] * len(pts)
    keep[0] = keep[-1] = True
    while st:
        i, j = st.pop()
        if j <= i + 1:
            continue
        worst, wi = 0, -1
        for k in range(i + 1, j):
            v = d2(pts[k], pts[i], pts[j])
            if v > worst:
                worst, wi = v, k
        if worst > eps * eps:
            keep[wi] = True
            st += [(i, wi), (wi, j)]
    return [p for p, k in zip(pts, keep) if k]


def bezier(pts, closed):
    P = pts[:]
    if closed and (abs(P[0][0] - P[-1][0]) > .01 or abs(P[0][1] - P[-1][1]) > .01):
        P = P + [P[0]]
    if len(P) < 4:
        return None
    out = [f'M{P[0][0]:.1f},{P[0][1]:.1f}']
    for i in range(len(P) - 1):
        p0 = P[i - 1] if i > 0 else (P[-2] if closed else P[0])
        p1, p2 = P[i], P[i + 1]
        p3 = P[i + 2] if i + 2 < len(P) else (P[1] if closed else P[-1])
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append(f'C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} '
                   f'{p2[0]:.1f},{p2[1]:.1f}')
    if closed:
        out.append('Z')
    return ''.join(out)


def dms(v, pos, neg):
    h = pos if v >= 0 else neg
    v = abs(v)
    d = int(v)
    m = int((v - d) * 60)
    s = int(round(((v - d) * 60 - m) * 60))
    if s == 60:
        s, m = 0, m + 1
    return f"{d}°{m:02d}'{s:02d}\"{h}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--geojson', default='')
    ap.add_argument('--out', default=OUT)
    # Relief shape, exposed so it can be swept against a rendered preview rather
    # than tuned blind through a browser. See the field below for what each does.
    ap.add_argument('--coastal', type=float, default=0.85)
    ap.add_argument('--peaks', type=float, default=0.60)
    ap.add_argument('--cap', type=float, default=0.60)
    ap.add_argument('--sigma', type=float, default=20.0)
    ap.add_argument('--sigma-scale', type=float, default=22.0)
    ap.add_argument('--levels', type=int, default=N_LAND_LEVELS)
    args = ap.parse_args()

    path = args.geojson
    tmp = None
    if not path:
        tmp = tempfile.NamedTemporaryFile(suffix='.geojson', delete=False)
        tmp.close()
        path = tmp.name
        print('fetching province boundaries…', flush=True)
        subprocess.run(['curl', '-sSf', '-o', path, GEOJSON_URL], check=True)

    rings = load_rings(path, PROVINCES, want=4)
    # Every OTHER Spanish province too, purely to know where Galicia stops being
    # coast and starts being border. See the distance field below.
    neighbours = load_rings(path, None)
    print(f'{len(rings)} province rings, {len(neighbours)} rings of Spain', flush=True)

    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    lon0, lat1, lat0 = min(xs), max(ys), min(ys)
    latm = math.radians((lat0 + lat1) / 2)
    proj = [[(((p[0] - lon0) * math.cos(latm)), (lat1 - p[1])) for p in r] for r in rings]
    px = [p[0] for r in proj for p in r]
    py = [p[1] for r in proj for p in r]
    s = (VH * 0.86) / (max(py) - min(py))
    ox = PADX + VW * 0.36 - ((max(px) - min(px)) * s) / 2 - min(px) * s
    oy = PADY + (VH - (max(py) - min(py)) * s) / 2 - min(py) * s

    def place(lat, lon):
        return (((lon - lon0) * math.cos(latm)) * s + ox, (lat1 - lat) * s + oy)

    def rasterise(rs):
        im = Image.new('L', (W, H), 0)
        d_ = ImageDraw.Draw(im)
        for r in rs:
            d_.polygon([place(p[1], p[0]) for p in r], fill=255)
        return np.asarray(im) > 127

    land = rasterise(rings)
    iberia = rasterise(neighbours)

    print('distance field…', flush=True)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

    # Only the ATLANTIC is sea. Galicia meets the ocean on its west and north
    # sides; east and south-east it meets the rest of Iberia, which emphatically
    # does not drop to sea level — Pena Trevinca stands ON that border, and the
    # border there runs along the ridge itself.
    #
    # Measuring "rise away from the coast" against the whole outline treated
    # that land border as shoreline, so all 2127m of relief had to fall away
    # inside the ~12 units between the summit and the edge. Fourteen contour
    # levels then landed within 12 CSS pixels on a phone and merged into a
    # single dark smear.
    #
    # The neighbouring provinces give the real border for free: sea is simply
    # where no province is. Deriving it beats thresholding longitude, which puts
    # a straight crease through the field along the threshold line and leaves
    # visibly ruled contours.
    #
    # Portugal is not in this dataset, so the southern border reads as sea. That
    # is the right answer anyway — it is the Mino valley, which really is low.
    sea = ~iberia
    signed = np.where(iberia, chamfer(iberia.tolist()), -chamfer(sea.tolist()))
    signed = blur(signed.astype(np.float32), 2, 2)

    # Normalised against Galicia itself, not the whole padded canvas: the field
    # keeps climbing east past the border now, and scaling by that maximum would
    # flatten the province into the bottom of the range.
    coastal = np.clip(signed, 0, None)
    coastal = coastal / max(1e-6, float(coastal[land].max()))

    # Distance-from-the-ocean rises steadily west to east, so on its own its
    # level sets are north-south bands sweeping the whole province — at the old
    # 0.85 weight it swamped the summits and the map read as parallel stripes
    # with no rings at all.
    #
    # --cap flattens it above a fraction of its range: the ramp then draws the
    # western half, where there are no summits to draw it, and goes level across
    # the eastern uplands so the peaks are what shapes the ground there. That
    # split is what gets contours across the whole province AND rings on the
    # mountains, which measuring from a single source cannot do.
    if args.cap < 1.0:
        coastal = np.minimum(coastal, args.cap) / args.cap
    elev = coastal * args.coastal
    for _, lat, lon, m in PEAKS:
        cx, cy = place(lat, lon)
        sigma = args.sigma + args.sigma_scale * (m / MAX_ELEV)
        elev += np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma * sigma))) \
            * (m / MAX_ELEV) * args.peaks
    # Blurred WITHOUT masking to land first: multiplying by the mask here is what
    # pinned the field to zero along the border, which is the whole defect. The
    # contours are cut to Galicia after tracing instead.
    elev = blur(elev, 2, 2)
    field = np.where(sea, signed, elev * 140.0).astype(np.float32)

    hi = float((elev * 140.0)[land].max())
    levels = [hi * ((k / float(args.levels)) ** 0.78)
              for k in range(1, args.levels + 1)]

    def clip_to_land(line, closed):
        """Cut a traced contour down to the parts that lie on Galicia.

        The field is now continuous across the land border, so contours run off
        the eastern edge instead of being compressed into it. They are trimmed
        here, which is how a regional map reads anyway: lines that meet the
        frame and stop.
        """
        inside = []
        for x, y in line:
            ix, iy = int(round(x)), int(round(y))
            inside.append(0 <= iy < H and 0 <= ix < W and bool(land[iy, ix]))
        if all(inside):
            return [(line, closed)]
        runs, cur = [], []
        for pt, ok in zip(line, inside):
            if ok:
                cur.append(pt)
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        # A closed ring cut open at the border has its start and end in the same
        # run; rejoin them so it is not drawn as two strokes meeting at a seam.
        if closed and len(runs) > 1 and inside[0] and inside[-1]:
            runs[0] = runs[-1] + runs[0]
            runs.pop()
        return [(r, False) for r in runs if len(r) > 3]

    print('tracing contours…', flush=True)
    # The silhouette comes from the land mask itself. It used to be the level-0
    # crossing, which worked only while the field was forced to zero all the way
    # round; with a continuous field there is no zero crossing on the eastern
    # side, and the outline would have been left open.
    bands = []
    outline = []
    # Lightly blurred first: marching a hard binary mask gives a pixel staircase,
    # and the rias are too fine to survive being smoothed after the fact.
    for line in marching(blur(land.astype(np.float32), 1, 1), 0.5):
        p = [((x - PADX) * SC, (y - PADY) * SC) for x, y in chaikin(line, 2)]
        per = sum(math.dist(p[i], p[i + 1]) for i in range(len(p) - 1))
        p = rdp(p, max(0.6, min(2.6, per / 300)))
        if len(p) < 7:
            continue
        b = bezier(p, math.dist(p[0], p[-1]) < 3)
        if b:
            outline.append(b)
    if outline:
        bands.append({'i': 0, 'coast': True, 'd': outline})

    for li, lv in enumerate(levels, start=1):
        paths = []
        for line in marching(field, lv):
            for seg, closed in clip_to_land(line, math.dist(line[0], line[-1]) < 3):
                p = [((x - PADX) * SC, (y - PADY) * SC) for x, y in chaikin(seg, 2)]
                per = sum(math.dist(p[i], p[i + 1]) for i in range(len(p) - 1))
                p = rdp(p, max(0.6, min(2.6, per / 300)))
                if len(p) < 7:
                    continue
                b = bezier(p, closed)
                if b:
                    paths.append(b)
        if paths:
            bands.append({'i': li, 'coast': False, 'd': paths})

    OW, OH = VW * SC, VH * SC
    coords = []
    for b in bands:
        for p in b['d']:
            coords += [(float(m.group(1)), float(m.group(2)))
                       for m in re.finditer(r'(-?\d+\.?\d*),(-?\d+\.?\d*)', p)]
    cx = (min(c[0] for c in coords) + max(c[0] for c in coords)) / 2
    cy = (min(c[1] for c in coords) + max(c[1] for c in coords)) / 2
    dx, dy = OW / 2 - cx, OH / 2 - cy

    def shift(p):
        return re.sub(r'(-?\d+\.?\d*),(-?\d+\.?\d*)',
                      lambda m: f'{float(m.group(1)) + dx:.1f},{float(m.group(2)) + dy:.1f}', p)
    for b in bands:
        b['d'] = [shift(p) for p in b['d']]

    peaks = []
    for name, lat, lon, m in PEAKS:
        X, Y = place(lat, lon)
        peaks.append({
            'name': name, 'elev': m,
            'x': round((X - PADX) * SC + dx, 1), 'y': round((Y - PADY) * SC + dy, 1),
            'coords': f'{dms(lat, "N", "S")}  {dms(lon, "E", "W")}',
            'side': 'right',
        })
    # Manzaneda and Trevinca are ~0.4 deg apart and their labels overlap when
    # both sit to the right of their mark. The leftmost of any close pair puts
    # its text on the other side; the mark itself never moves.
    for i, a_ in enumerate(peaks):
        for b_ in peaks[i + 1:]:
            if abs(a_['y'] - b_['y']) < 60 and abs(a_['x'] - b_['x']) < 190:
                (a_ if a_['x'] <= b_['x'] else b_)['side'] = 'left'

    # A viewBox hugging the drawing, not the working canvas: the contours only
    # occupy the middle ~57% of it, and letterboxing all that empty margin left
    # the map tiny on a phone.
    bx0 = min(c[0] for c in coords) + dx
    bx1 = max(c[0] for c in coords) + dx
    by0 = min(c[1] for c in coords) + dy
    by1 = max(c[1] for c in coords) + dy
    pad = 18
    vb = (round(bx0 - pad), round(by0 - pad),
          round(bx1 - bx0 + 2 * pad), round(by1 - by0 + 2 * pad))

    n_paths = sum(len(b['d']) for b in bands)
    weight = sum(len(p) for b in bands for p in b['d'])
    print(f'{len(bands)} levels, {n_paths} paths, {weight / 1024:.1f} KB', flush=True)

    ts = f'''// GENERATED by scripts/make-galicia-chart.py — do not edit by hand.
//
// Contours of Galicia for the intro. The coastline comes from the four real
// province boundaries; the relief is shaped by the real summits below, so a pin
// and the contour under it agree. `band` rises from 0 (sea level) to
// {len(bands) - 1} (the summits) — the intro draws them in that order.
export type ChartBand = {{ band: number; coast: boolean; d: string[] }};
export type ChartPeak = {{ name: string; elev: number; x: number; y: number; coords: string; side: 'left' | 'right' }};

export const CHART_W = {OW};
export const CHART_H = {OH};
/** Hugs the drawing rather than the working canvas — see the generator. */
export const CHART_VIEWBOX = '{vb[0]} {vb[1]} {vb[2]} {vb[3]}';
export const VIEW_X = {vb[0]};
export const VIEW_Y = {vb[1]};
export const VIEW_W = {vb[2]};
export const VIEW_H = {vb[3]};
export const MAX_ELEV = {MAX_ELEV};
export const BAND_COUNT = {len(bands)};

export const CHART_BANDS: ChartBand[] = {json.dumps(
        [{'band': b['i'], 'coast': b['coast'], 'd': b['d']} for b in bands])};

export const CHART_PEAKS: ChartPeak[] = {json.dumps(peaks, ensure_ascii=False)};
'''
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write(ts)
    print(f'wrote {args.out} ({len(ts) / 1024:.1f} KB)')
    if tmp:
        os.unlink(tmp.name)


if __name__ == '__main__':
    main()
