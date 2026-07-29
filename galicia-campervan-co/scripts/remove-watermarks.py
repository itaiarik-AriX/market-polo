#!/usr/bin/env python3
"""Paint out the generator's burned-in marks, letters only.

The 4K master carries three marks from the tool that produced it:

    sparkle (four-pointed star)  frames 1-147    welcome / exterior
    Ltx-2   (the loud one)       frames ~296+    view / closing
    Veo     (small, corner)      whole clip

An earlier pass defocused the whole corner and was rejected: it softened real
footage to hide a small mark. This fills only the glyphs, from the pixels around
them, so the framing is untouched — nothing is cropped, nothing else is blurred.

Four things here are load-bearing, each arrived at by measuring rather than
looking, after earlier versions of this script shipped visible residue:

1.  Masks follow the glyph BODY, not its outline. A local high-pass finds edges
    only; filling the contour interiors is what closes them.
2.  Masks are dilated generously (DILATE px). cv2.inpaint samples from the mask
    boundary, so a mask stopping inside a glyph feeds white back in and redraws
    it. Bright-edge residue on frame 362, against a 2.2% scene-detail floor:
    3.99% at 15px, 2.53% at 21, 2.36% at 25. Shipping 25.
3.  Marks are located per frame by TEMPLATE MATCHING, not by brightness.
    Brightness cannot tell a white glyph from sunlit grass or a wicker basket:
    an earlier version painted only 95 of the sparkle's ~145 frames, and put
    Ltx-2's range at 220-457 when it truly starts near 296 — which would have
    smeared 80 clean frames. Correlation separates cleanly: Ltx-2 scores
    0.14-0.25 where absent and 0.84-0.88 where present. It also tracks the
    sparkle, which drifts about 140x37px.
4.  Intermediates are PNG, never WebP. Painting an already-encoded WebP and
    re-saving compresses twice: 39.43 dB against 41.63 dB for a single encode.

Reference frames come from the master, never from public/sequences — this script
overwrites that directory, so learning from it would mean a second run derives
its masks from already-painted frames.

The portrait tiers need no work: their 9:16 window ends before the marks.

Usage: python3 scripts/remove-watermarks.py [--dry-run] [--only hire,hire-sm,stations]
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SRC = 'raw-footage/van-life-2.mp4'
FPS = 12
REF_W, REF_H = 1920, 1080
N_FRAMES = 457

DILATE = 25
INPAINT_RADIUS = 12

# name, box in 1920x1080, frames to learn the template from, frames to search,
# correlation threshold. The measured margins are wide, so these are not
# delicate settings.
TRACKED = [
    ('ltx',     (1560, 900, 1870, 1080), (295, 457), (0, 457), 0.50),
    ('sparkle', (1650, 830, 1920, 1010), (0, 140),   (0, 190), 0.55),
]

# "Veo" is ~40x30px hard against the bottom-right corner — too small and too
# close to the edge to correlate reliably, so it gets a fixed rectangle, located
# by inspection at 2x, painted on every frame. A rect that came and went would
# shimmer in the corner while scrolling, and at 0.12% of frame in the extreme
# corner painting it always costs almost nothing. It matters on 16:9 windows,
# where cover-fit does not crop it away.
VEO_RECT = (1860, 1040, 1920, 1080)

TIERS = {
    'hire':    ('public/sequences/hire', 1920, 88),
    'hire-sm': ('public/sequences/hire-sm', 1080, 82),
}
STATIONS_DIR = 'public/sequences/hire-stations'
STATION_W, STATION_QUALITY = 3840, 92
STATIONS = [('view', 362), ('closing', 456)]   # the only two in a marked stretch


def local_high(gray, sigma=15):
    return gray - cv2.GaussianBlur(gray, (0, 0), sigma)


def hp_u8(path, box):
    g = np.asarray(Image.open(path).convert('L').crop(box), dtype=np.float32)
    return np.clip((local_high(g) + 40) / 80 * 255, 0, 255).astype(np.uint8)


def build_template(files, box, lo, hi):
    """Average local high-pass over a range: a fixed mark survives, scene cancels."""
    acc, n = None, 0
    for f in files[lo:hi]:
        g = np.asarray(Image.open(f).convert('L').crop(box), dtype=np.float32)
        r = local_high(g)
        acc = r if acc is None else acc + r
        n += 1
    mean = acc / n
    norm = np.clip((mean - mean.min()) / (mean.max() - mean.min()) * 255,
                   0, 255).astype(np.uint8)
    _, th = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [cv2.boundingRect(c) for c in cnts if cv2.contourArea(c) > 50]
    if not boxes:
        return None, None
    x0 = max(0, min(b[0] for b in boxes) - 6)
    y0 = max(0, min(b[1] for b in boxes) - 6)
    x1 = max(b[0] + b[2] for b in boxes) + 6
    y1 = max(b[1] + b[3] for b in boxes) + 6
    tpl = norm[y0:y1, x0:x1]

    _, tm = cv2.threshold(tpl, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    c2, _ = cv2.findContours(tm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    shape = np.zeros_like(tm)
    cv2.drawContours(shape, c2, -1, 255, -1)          # solid glyphs, not edges
    shape = cv2.dilate(shape, np.ones((DILATE, DILATE), np.uint8), 1)
    return tpl, shape


def track(files, box, tpl, corr, lo, hi):
    """{frame index: (y, x)} wherever the template correlates above `corr`."""
    found = {}
    for i in range(lo, min(hi, len(files))):
        m = cv2.matchTemplate(hp_u8(files[i], box), tpl, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(m)
        if mx >= corr:
            found[i] = (loc[1] + box[1], loc[0] + box[0])
    return found


def scale_mask(mask_full, w):
    if w == REF_W:
        return mask_full
    h = int(round(w * REF_H / REF_W / 2)) * 2
    m = cv2.resize(mask_full, (w, h), interpolation=cv2.INTER_NEAREST)
    return (m > 127).astype(np.uint8) * 255


def paint(img_rgb, mask, radius):
    return cv2.cvtColor(
        cv2.inpaint(cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR), mask,
                    radius, cv2.INPAINT_TELEA),
        cv2.COLOR_BGR2RGB)


def extract(src, w, out_dir):
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', src,
         '-vf', f'fps={FPS},scale={w}:-2', '-c:v', 'png',
         '-y', os.path.join(out_dir, '%04d.png')], check=True)
    return sorted(glob.glob(os.path.join(out_dir, '*.png')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--only', default='hire,hire-sm,stations')
    args = ap.parse_args()
    want = set(args.only.split(','))

    if not os.path.exists(SRC):
        sys.exit(f'missing {SRC}')

    ref_tmp = tempfile.mkdtemp(prefix='wm-ref-')
    print(f'extracting reference frames at {REF_W}px…', flush=True)
    files = extract(SRC, REF_W, ref_tmp)
    if len(files) != N_FRAMES:
        shutil.rmtree(ref_tmp, ignore_errors=True)
        sys.exit(f'expected {N_FRAMES} reference frames, found {len(files)}')

    # ---- locate every mark, per frame --------------------------------------
    per_frame = {}
    union = np.zeros((REF_H, REF_W), np.uint8)

    def stamp(i, y, x, shape):
        h, w = shape.shape
        y, x = max(0, min(y, REF_H - h)), max(0, min(x, REF_W - w))
        layer = per_frame.get(i)
        if layer is None:
            layer = per_frame[i] = np.zeros((REF_H, REF_W), np.uint8)
        layer[y:y + h, x:x + w] = np.maximum(layer[y:y + h, x:x + w], shape)
        union[y:y + h, x:x + w] = np.maximum(union[y:y + h, x:x + w], shape)

    for name, box, (llo, lhi), (slo, shi), corr in TRACKED:
        tpl, shape = build_template(files, box, llo, lhi)
        if tpl is None:
            sys.exit(f'{name}: could not build a template')
        hits = track(files, box, tpl, corr, slo, shi)
        for i, (y, x) in hits.items():
            stamp(i, y, x, shape)
        rng = (min(hits) + 1, max(hits) + 1) if hits else None
        print(f'  {name:8s} template {tpl.shape[1]}x{tpl.shape[0]}, '
              f'on {len(hits):3d} frames, range {rng}', flush=True)

    vx0, vy0, vx1, vy1 = VEO_RECT
    veo = np.full((vy1 - vy0, vx1 - vx0), 255, np.uint8)
    for i in range(len(files)):
        stamp(i, vy0, vx0, veo)
    print(f'  {"veo":8s} fixed rect, on {len(files)} frames', flush=True)
    print(f'  union {100*(union>0).mean():.2f}% of frame; '
          f'{len(per_frame)}/{len(files)} frames painted', flush=True)

    if args.dry_run:
        shutil.rmtree(ref_tmp, ignore_errors=True)
        return

    # ---- scrub tiers --------------------------------------------------------
    for tier in ('hire', 'hire-sm'):
        if tier not in want:
            continue
        out_dir, w, q = TIERS[tier]
        masks = {i: scale_mask(m, w) for i, m in per_frame.items()}
        reuse = (w == REF_W)
        tmp = ref_tmp if reuse else tempfile.mkdtemp(prefix=f'wm-{tier}-')
        try:
            if reuse:
                print(f'\n{tier}: reusing the {w}px reference frames…', flush=True)
                made = files
            else:
                print(f'\n{tier}: extracting {w}px as PNG…', flush=True)
                made = extract(SRC, w, tmp)
                if len(made) != N_FRAMES:
                    sys.exit(f'{tier}: got {len(made)} frames, expected {N_FRAMES}')
            print(f'{tier}: painting {len(masks)} of {len(made)}…', flush=True)
            for n, p in enumerate(made):
                idx = int(os.path.basename(p)[:4]) - 1
                img = np.asarray(Image.open(p).convert('RGB'))
                if idx in masks:
                    img = paint(img, masks[idx], INPAINT_RADIUS)
                Image.fromarray(img).save(
                    os.path.join(out_dir, f'{idx+1:04d}.webp'),
                    'WEBP', quality=q, method=6)
                os.unlink(p)
                if n % 100 == 0:
                    print(f'  {tier}: {n}/{len(made)}', flush=True)
            print(f'{tier}: done -> {out_dir}', flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            if reuse:
                ref_tmp = None

    if ref_tmp:
        shutil.rmtree(ref_tmp, ignore_errors=True)

    # ---- sharp station stills ----------------------------------------------
    if 'stations' in want:
        print('\nstations: re-extracting view + closing at 3840…', flush=True)
        for sid, frame in STATIONS:
            m = per_frame.get(frame)
            if m is None:
                print(f'  {sid}: no mark on frame {frame}, skipping', flush=True)
                continue
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tf:
                png = tf.name
            try:
                subprocess.run(
                    ['ffmpeg', '-v', 'error', '-ss', f'{frame / FPS:.6f}',
                     '-i', SRC, '-frames:v', '1', '-y', png], check=True)
                img = np.asarray(Image.open(png).convert('RGB'))
                h, w = img.shape[:2]
                out = os.path.join(STATIONS_DIR, f'{sid}.webp')
                Image.fromarray(
                    paint(img, scale_mask(m, w)[:h, :w], INPAINT_RADIUS * 2)
                ).save(out, 'WEBP', quality=STATION_QUALITY, method=6)
                print(f'  {sid} ({w}x{h}) -> {out}', flush=True)
            finally:
                if os.path.exists(png):
                    os.unlink(png)


if __name__ == '__main__':
    main()
