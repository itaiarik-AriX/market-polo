#!/usr/bin/env python3
"""Render the portrait phone tier from the 4K master.

A phone in portrait cover-fits the 16:9 frames to about 26% of their width and
upscales roughly 4x, which throws away three quarters of every shot — on the
welcome frame it crops the van out entirely. This cuts a 9:16 window from the
master instead, panning it horizontally so each station stays composed, and
interpolating the pan between stations so the movement is continuous.

Offsets were chosen per station by inspection and checked against the burned-in
watermarks: welcome 88-93%, exterior 86-91%, view 80-93%, closing 82-93% of
frame width. Every window below ends before its station's mark, closing with
the tightest margin at 4%. Change an offset and re-check that.

Usage: python3 scripts/make-portrait-tier.py
"""
import os
import shutil
import subprocess
import sys

SRC = 'raw-footage/van-life-2.mp4'
SEQ_OUT = 'public/sequences/hire-portrait'
STILL_OUT = 'public/sequences/hire-stations-portrait'

MASTER_W, MASTER_H = 3840, 2160
CROP_W = 1215                      # 9:16 window out of a 3840x2160 frame
OUT_W = int(__import__('os').environ.get('OUT_W', 1080))
OUT_H = OUT_W * 16 // 9
FPS = 12
QUALITY = 82                       # matches the existing mobile tier; ~23MB total
STILL_QUALITY = 92

# (station id, frame index on the 12fps grid, horizontal centre as a fraction)
STATIONS = [
    ('welcome',   0,   0.58),
    ('exterior',  81,  0.58),
    ('amenities', 227, 0.45),
    ('view',      362, 0.48),
    ('closing',   456, 0.62),
]
TOTAL_FRAMES = 457


def centre_to_x(c):
    """Left edge of the crop window, clamped inside the frame."""
    return max(0, min(MASTER_W - CROP_W, int(round(c * MASTER_W - CROP_W / 2))))


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'ffmpeg failed:\n{" ".join(cmd)}\n{r.stderr[-2000:]}')


def main():
    if not os.path.exists(SRC):
        sys.exit(f'{SRC} not found — pull it from the van-demo-2 GitHub release first.')

    for d in (SEQ_OUT, STILL_OUT):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)

    # --- the panned sequence, one ffmpeg pass per station-to-station segment ---
    # Each segment ramps the crop's x linearly. Segments stop one frame short of
    # the next station so no frame is rendered twice; the final segment lands
    # exactly on the last station.
    for i in range(len(STATIONS) - 1):
        (_, f0, c0), (nid, f1, c1) = STATIONS[i], STATIONS[i + 1]
        x0, x1 = centre_to_x(c0), centre_to_x(c1)
        last = i == len(STATIONS) - 2
        count = (f1 - f0 + 1) if last else (f1 - f0)
        span = (count - 1) if last else (f1 - f0)
        expr = str(x0) if x0 == x1 else f'{x0}+({x1 - x0})*n/{span}'
        print(f'  frames {f0:4}-{f0 + count - 1:4} -> {nid:10} x {x0}->{x1}')
        run([
            'ffmpeg', '-y', '-v', 'error', '-ss', str(f0 / FPS), '-i', SRC,
            '-frames:v', str(count),
            '-vf', f'fps={FPS},crop={CROP_W}:{MASTER_H}:{expr}:0,scale={OUT_W}:{OUT_H}',
            '-c:v', 'libwebp', '-quality', str(QUALITY),
            '-start_number', str(f0 + 1),          # files are 1-based: 0001.webp
            f'{SEQ_OUT}/%04d.webp',
        ])

    n = len(os.listdir(SEQ_OUT))
    if n != TOTAL_FRAMES:
        sys.exit(f'expected {TOTAL_FRAMES} frames, produced {n}')

    # --- per-station stills, at the native crop width so they stay sharp ---
    for sid, frame, c in STATIONS:
        x = centre_to_x(c)
        run([
            'ffmpeg', '-y', '-v', 'error', '-ss', str(frame / FPS), '-i', SRC,
            '-frames:v', '1',
            '-vf', f'crop={CROP_W}:{MASTER_H}:{x}:0,unsharp=5:5:0.8:5:5:0.0',
            '-c:v', 'libwebp', '-quality', str(STILL_QUALITY),
            f'{STILL_OUT}/{sid}.webp',
        ])

    for d in (SEQ_OUT, STILL_OUT):
        kb = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)) / 1024
        biggest = max(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)) / 1024
        print(f'{d}: {len(os.listdir(d))} files, {kb / 1024:.1f} MB, largest {biggest:.0f} KB')


if __name__ == '__main__':
    main()
