#!/usr/bin/env python3
"""Paint out the generator's burned-in marks, letters only.

The 4K master carries three marks from the tool that produced it, all at fixed
screen positions but each only over part of the clip:

    sparkle (four-pointed star)  ~frames 1-142    welcome / exterior
    Ltx-2   (the loud one)       ~frames 278-457  view / closing
    Veo     (small, corner)      whole clip

An earlier pass defocused the whole corner and was rejected: it softened real
footage to hide a small mark. This fills only the glyphs, from the pixels around
them, so the framing is untouched — nothing is cropped, nothing else is blurred.
Measured union coverage is 0.74% of the frame.

Three things here are load-bearing, and each was arrived at by measurement:

1.  The mask must cover the glyph BODY, not its outline. A local high-pass finds
    edges only; filling the contour interiors is what closes it.
2.  The mask must then be dilated (DILATE px). cv2.inpaint samples from the mask
    boundary, so a mask stopping inside the glyph feeds white back in and redraws
    the letters. A sweep at 15/23/31 showed 15 is the smallest that clears it;
    larger only widens the smoothed patch.
3.  Intermediates are PNG, never WebP. Painting an already-encoded WebP and
    re-saving compresses the frame twice: measured 39.43 dB on frame 1 against
    41.63 dB for a single encode. Every frame goes lossless -> paint -> one
    WebP encode.

Masks are derived from the shipped 1920 frames (any tier would do — same
picture) and scaled per tier. Frames outside a mark's detected range are left
alone, so clean footage is never painted.

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
REF_SEQ = 'public/sequences/hire'          # 1920x1080, used to derive the masks
FPS = 12
REF_W, REF_H = 1920, 1080

DILATE = 15                                # see note 2 above
INPAINT_RADIUS = 10
BRIGHT_OVER_LOCAL = 6                      # mark is brighter than its surround
PRESENT_IN_FRACTION = 0.75                 # burned in, not passing scene detail
DETECT_SIGMA = 3.0                         # frames scoring above clean baseline

# (name, search box in 1920x1080, frame range to learn the shape from).
# Shapes are derived from the footage rather than hand-drawn, so each mask
# follows the actual glyphs.
MARKS = [
    ('sparkle', (1650, 830, 1920, 1010), (0, 140)),
    ('ltx',     (1560, 900, 1870, 1080), (295, 457)),
]

# "Veo" is ~40x30px hard against the bottom-right corner. Too small and too near
# the edge for the vote-based derivation to resolve (the ring it would be scored
# against falls off-frame), so it gets a fixed rectangle, located by inspection
# at 2x. Painted on EVERY frame on purpose: brightness detection here fires on
# sea glare as readily as on the glyph, and a rect that came and went would
# shimmer in the corner while scrolling. At 0.12% of frame in the extreme corner
# that costs almost nothing, and it guarantees the mark is gone on 16:9 windows,
# where cover-fit does not crop it away.
VEO_RECT = (1860, 1040, 1920, 1080)

TIERS = {
    # name: (out dir, width, webp quality) — quality matches the existing tiers
    'hire':    ('public/sequences/hire', 1920, 88),
    'hire-sm': ('public/sequences/hire-sm', 1080, 82),
}
STATIONS_DIR = 'public/sequences/hire-stations'
STATION_W, STATION_QUALITY = 3840, 92
STATIONS = [('view', 362), ('closing', 456)]   # the only two in a marked stretch


def local_high(gray, sigma=15):
    return gray - cv2.GaussianBlur(gray, (0, 0), sigma)


def derive_mask(files, box, lo, hi):
    """Glyph-shaped mask: bright above local surround in most frames of a range."""
    votes = None
    n = 0
    for f in files[lo:hi]:
        g = np.asarray(Image.open(f).convert('L').crop(box), dtype=np.float32)
        bright = local_high(g) > BRIGHT_OVER_LOCAL
        votes = bright.astype(np.float32) if votes is None else votes + bright
        n += 1
    m = ((votes / n) > PRESENT_IN_FRACTION).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, cnts, -1, 255, -1)          # solid centres, not edges
    return cv2.dilate(filled, np.ones((DILATE, DILATE), np.uint8), 1)


def detect_frames(files, box, mask, lo_hint, hi_hint):
    """Which frames actually carry this mark.

    Scored as how much brighter the masked glyph is than the ring just outside
    it, calibrated against frames known to be clean — so a fade in or out is
    picked up without hard-coding frame numbers.
    """
    sel = mask > 0
    ring = cv2.dilate(mask, np.ones((25, 25), np.uint8), 1) > 0
    ring &= ~sel
    if sel.sum() == 0 or ring.sum() == 0:
        return set()
    scores = []
    for f in files:
        g = np.asarray(Image.open(f).convert('L').crop(box), dtype=np.float32)
        scores.append(float(g[sel].mean() - g[ring].mean()))
    scores = np.array(scores)
    outside = np.ones(len(scores), bool)
    outside[max(0, lo_hint - 30):min(len(scores), hi_hint + 30)] = False
    if outside.sum() < 20:
        outside = np.ones(len(scores), bool)
        outside[lo_hint:hi_hint] = False
    base, sd = scores[outside].mean(), scores[outside].std() + 1e-6
    return set(np.where(scores > base + DETECT_SIGMA * sd)[0].tolist())


def scaled(mask_full, w):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--only', default='hire,hire-sm,stations')
    args = ap.parse_args()
    want = set(args.only.split(','))

    if not os.path.exists(SRC):
        sys.exit(f'missing {SRC}')
    files = sorted(glob.glob(os.path.join(REF_SEQ, '*.webp')))
    if len(files) != 457:
        sys.exit(f'expected 457 reference frames, found {len(files)}')

    # ---- masks, and which frames each mark is actually on -------------------
    full = np.zeros((REF_H, REF_W), np.uint8)
    per_frame = {}

    def add(name, layer, frames):
        nonlocal full
        for i in frames:
            cur = per_frame.get(i)
            per_frame[i] = layer.copy() if cur is None else np.maximum(cur, layer)
        full = np.maximum(full, layer)
        rng = (min(frames) + 1, max(frames) + 1) if frames else None
        print(f'  {name:8s} {100*(layer>0).mean():5.3f}% of frame, '
              f'on {len(frames):3d} frames, range {rng}', flush=True)

    for name, box, (lo, hi) in MARKS:
        m = derive_mask(files, box, lo, hi)
        frames = detect_frames(files, box, m, lo, hi)
        x0, y0, x1, y1 = box
        layer = np.zeros((REF_H, REF_W), np.uint8)
        layer[y0:y1, x0:x1] = m
        add(name, layer, frames)

    vx0, vy0, vx1, vy1 = VEO_RECT
    veo_layer = np.zeros((REF_H, REF_W), np.uint8)
    veo_layer[vy0:vy1, vx0:vx1] = 255
    add('veo', veo_layer, set(range(len(files))))

    print(f'  union {100*(full>0).mean():.2f}% of frame; '
          f'{len(per_frame)}/457 frames painted', flush=True)
    if args.dry_run:
        return

    # ---- scrub tiers --------------------------------------------------------
    for tier in ('hire', 'hire-sm'):
        if tier not in want:
            continue
        out_dir, w, q = TIERS[tier]
        m_tier = {i: scaled(m, w) for i, m in per_frame.items()}
        tmp = tempfile.mkdtemp(prefix=f'wm-{tier}-')
        try:
            print(f'\n{tier}: extracting {w}px from the master as PNG…', flush=True)
            subprocess.run(
                ['ffmpeg', '-v', 'error', '-i', SRC,
                 '-vf', f'fps={FPS},scale={w}:-2', '-c:v', 'png',
                 '-y', os.path.join(tmp, '%04d.png')],
                check=True)
            made = sorted(glob.glob(os.path.join(tmp, '*.png')))
            if len(made) != 457:
                sys.exit(f'{tier}: extracted {len(made)} frames, expected 457')
            print(f'{tier}: painting {len(m_tier)} of {len(made)}…', flush=True)
            for n, p in enumerate(made):
                idx = int(os.path.basename(p)[:4]) - 1
                img = np.asarray(Image.open(p).convert('RGB'))
                if idx in m_tier:
                    img = paint(img, m_tier[idx], INPAINT_RADIUS)
                Image.fromarray(img).save(
                    os.path.join(out_dir, f'{idx+1:04d}.webp'),
                    'WEBP', quality=q, method=6)
                os.unlink(p)                     # keep peak disk bounded
                if n % 100 == 0:
                    print(f'  {tier}: {n}/{len(made)}', flush=True)
            print(f'{tier}: done -> {out_dir}', flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ---- sharp station stills ----------------------------------------------
    if 'stations' in want:
        print('\nstations: re-extracting view + closing at 3840…', flush=True)
        m_st = scaled(full, STATION_W)
        for sid, frame in STATIONS:
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tf:
                png = tf.name
            try:
                subprocess.run(
                    ['ffmpeg', '-v', 'error', '-ss', f'{frame / FPS:.6f}',
                     '-i', SRC, '-frames:v', '1', '-y', png], check=True)
                img = np.asarray(Image.open(png).convert('RGB'))
                h, w = img.shape[:2]
                mask = m_st[:h, :w]
                out = os.path.join(STATIONS_DIR, f'{sid}.webp')
                Image.fromarray(paint(img, mask, INPAINT_RADIUS * 2)).save(
                    out, 'WEBP', quality=STATION_QUALITY, method=6)
                print(f'  {sid} ({w}x{h}) -> {out}', flush=True)
            finally:
                os.path.exists(png) and os.unlink(png)


if __name__ == '__main__':
    main()
