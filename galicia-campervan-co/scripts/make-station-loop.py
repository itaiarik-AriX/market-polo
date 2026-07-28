"""Turn a generated station clip into a seamless ambient loop.

    python3 scripts/make-station-loop.py welcome

Reads docs/station-clips/<n>-<id>-raw.mp4, writes public/loops/<id>.{mp4,webm}.

What the generator handed back needed four corrections, in this order:

  1. GEOMETRY (and grade). Every clip so far came back re-framed — welcome ~7%
     wider, closing ~2% — and welcome's camera also drifted ~10px left. Both are
     undone in a single affine resample so the image is only interpolated once.
     Getting this right is what lets the loop hand over invisibly: the clip's
     first frame has to be the frame the canvas holds on, or the scrub pops when
     the loop fades out. Some clips also come back re-graded (closing was ~14%
     more contrasty), which needs matching for the same reason.

  2. THE GENERATOR'S OWN WATERMARK. Veo burns a sparkle into the bottom-right,
     and sometimes a wordmark too. A large framing correction can crop the
     wordmark away; the sparkle is removed by diffusion infill, the same method
     used for the input plates — it extrapolates the surrounding light inward
     rather than importing texture from elsewhere in the frame. Measure its box
     on the CORRECTED frames: mapping coordinates through the transform put the
     box 8px inside the sparkle's tip on closing, and it leaked.

  3. THE PEOPLE. Structured human motion is what makes a loop's repeat legible:
     the eye learns a gesture's arc and recognises the replay. Grass and water
     have no arc to memorise. So the couple are held at their frame-0 pose under
     a soft oval mask while everything around them keeps moving.

  4. THE SEAM. There is no natural cut point — wind-blown grass never returns to
     a previous state, so searching for a frame that matches frame 0 just scores
     the earliest candidate best and leaves a 2s loop, short enough to read as a
     rhythm. Instead keep the whole clip and blend its tail back over its head.
     The blend does superimpose two grass phases, so it stays short: the cost is
     a faint double image for its duration, paid over a small share of a long
     loop. Success is measured by where the wrap falls in the distribution of
     ordinary frame-to-frame changes — inside the normal spread means the eye has
     nothing to catch.
"""
import glob
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Per-station corrections, measured against the matching plate. Re-derive these
# for a new clip: align its first frame to docs/station-plates/<n>-<id>.png over
# a scale/offset search, and locate the marks on the corrected frames.
STATIONS = {
    'welcome': {
        'raw': 'docs/station-clips/1-welcome-raw.mp4',
        'plate': 'docs/station-plates/1-welcome.png',
        # plate(x, y) = clip((x + off_x) / scale, (y + off_y) / scale)
        'scale': 1.070, 'off_x': 42.0, 'off_y': 24.0,
        'sparkle': (1168, 586, 1230, 648),
        'donor_dy': 60,
        'freeze': (572, 374, 732, 478),   # the couple, as an ellipse
        # Channel means already landed within 0.6/255 of the plate here, and
        # forcing a match made it worse. Left alone.
        'colour_match': False,
    },
    'closing': {
        'raw': 'docs/station-clips/5-closing-raw.mp4',
        'plate': 'docs/station-plates/5-closing.png',
        'scale': 1.020, 'off_x': 12.0, 'off_y': 8.0,
        # Measured on the GEOMETRY-CORRECTED frames, not mapped through the
        # transform from the raw ones — mapping put the box 8px inside the
        # sparkle's left tip and it leaked.
        'sparkle': (1144, 574, 1202, 631),
        'donor_dy': 0,    # borrowed texture read worse than a clean soft patch here
        'freeze': (776, 484, 897, 578),
        # This one came back graded warmer and ~14% more contrasty than the
        # plate (per-channel std 71/47/41 against 63/40/36). Left uncorrected
        # the grade would visibly shift as the loop fades into the scrub.
        'colour_match': True,
    },
}

FPS = 24


def infill(arr, box, donor_dy=0, iters=400):
    """Diffusion infill, optionally re-textured.

    Diffusion alone produces a smooth patch, which against grass reads as a
    smudge — more conspicuous than the mark it replaced. So where a donor offset
    is given, the low frequencies come from the diffusion (correct local
    lighting, no imported structure) and the high frequencies are borrowed from
    a patch of real grass elsewhere in the same frame. The result carries the
    surrounding texture without copying anything recognisable.
    """
    x0, y0, x1, y1 = box
    work = arr.copy()
    seed = np.concatenate([arr[y0 - 4:y0, x0:x1].reshape(-1, 3),
                           arr[y0:y1, x0 - 4:x0].reshape(-1, 3)])
    work[y0:y1, x0:x1] = seed.mean(axis=0)
    sub = work[y0 - 1:y1 + 1, x0 - 1:x1 + 1]
    for _ in range(iters):
        sub[1:-1, 1:-1] = (sub[:-2, 1:-1] + sub[2:, 1:-1]
                           + sub[1:-1, :-2] + sub[1:-1, 2:]) / 4
    work[y0:y1, x0:x1] = sub[1:-1, 1:-1]

    if donor_dy:
        d = arr[y0 + donor_dy:y1 + donor_dy, x0:x1]
        blurred = np.asarray(
            Image.fromarray(np.clip(d, 0, 255).astype('uint8')).filter(
                ImageFilter.GaussianBlur(4)), dtype=np.float32)
        work[y0:y1, x0:x1] = np.clip(work[y0:y1, x0:x1] + (d - blurred), 0, 255)
    return work


def drift_of(frames, half):
    """Per-frame translation against frame 0, by coarse search at half res."""
    g0 = np.asarray(Image.open(frames[0]).convert('L').resize(half), dtype=np.float32)
    out = []
    for p in frames:
        g = np.asarray(Image.open(p).convert('L').resize(half), dtype=np.float32)
        best, bd = (0, 0), 1e18
        for dy in range(-8, 9):
            for dx in range(-8, 9):
                a = g0[10:-10, 10:-10]
                b = g[10 + dy:half[1] - 10 + dy, 10 + dx:half[0] - 10 + dx]
                d = np.abs(a - b).mean()
                if d < bd:
                    bd, best = d, (dx, dy)
        out.append(best)
    return out


def main(station):
    cfg = STATIONS[station]
    tmp = tempfile.mkdtemp()
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', cfg['raw'],
                    '-vsync', '0', f'{tmp}/f%04d.png'], check=True)
    FR = sorted(glob.glob(f'{tmp}/f*.png'))
    W, H = Image.open(FR[0]).size
    half = (W // 2, H // 2)
    print(f'{len(FR)} frames at {W}x{H}')

    # --- 1. geometry -------------------------------------------------------
    drift = drift_of(FR, half)
    s, ox, oy = cfg['scale'], cfg['off_x'], cfg['off_y']
    corrected = []
    for p, (dx, dy) in zip(FR, drift):
        im = Image.open(p).convert('RGB')
        coeff = (1 / s, 0, ox / s + dx * 2, 0, 1 / s, oy / s + dy * 2)
        corrected.append(im.transform((W, H), Image.AFFINE, coeff, resample=Image.BICUBIC))
    plate = np.asarray(Image.open(cfg['plate']).convert('RGB').resize((W, H), Image.LANCZOS),
                       dtype=np.float32)
    before = np.abs(np.asarray(Image.open(FR[0]).convert('RGB'), np.float32) - plate).mean()
    after_geom = np.abs(np.asarray(corrected[0], np.float32) - plate).mean()

    # Match the clip's grade to the plate's, from the first frame's statistics
    # and applied to every frame so the loop's own grade stays stable. Without
    # it a re-graded clip visibly shifts colour as it fades into the scrub.
    if cfg.get('colour_match'):
        a0 = np.asarray(corrected[0], dtype=np.float32)
        src_m, src_s = a0.mean(axis=(0, 1)), a0.std(axis=(0, 1))
        dst_m, dst_s = plate.mean(axis=(0, 1)), plate.std(axis=(0, 1))
        graded = []
        for im in corrected:
            a = np.asarray(im, dtype=np.float32)
            graded.append(Image.fromarray(
                np.clip((a - src_m) / src_s * dst_s + dst_m, 0, 255).astype('uint8')))
        corrected = graded
        after = np.abs(np.asarray(corrected[0], np.float32) - plate).mean()
        print('frame 0 vs plate: raw %.2f -> geometry %.2f -> colour %.2f'
              % (before, after_geom, after))
    else:
        print('frame 0 vs plate: raw %.2f -> geometry %.2f' % (before, after_geom))

    # --- 2 & 3. marks and people -------------------------------------------
    sm = Image.new('L', (W, H), 0)
    ImageDraw.Draw(sm).rectangle(cfg['sparkle'], fill=255)
    sp_mask = np.asarray(sm.filter(ImageFilter.GaussianBlur(5)), np.float32)[..., None] / 255

    fm = Image.new('L', (W, H), 0)
    ImageDraw.Draw(fm).ellipse(cfg['freeze'], fill=255)
    fz_mask = np.asarray(fm.filter(ImageFilter.GaussianBlur(14)), np.float32)[..., None] / 255

    frozen, proc = None, []
    for im in corrected:
        a = np.asarray(im, dtype=np.float32)
        a = a * (1 - sp_mask) + infill(a, cfg['sparkle'], cfg.get('donor_dy', 0)) * sp_mask
        if frozen is None:
            frozen = a.copy()
        proc.append(a * (1 - fz_mask) + frozen * fz_mask)

    # --- 4. seam -----------------------------------------------------------
    L = len(proc)
    adj = np.array([np.abs(proc[i + 1] - proc[i]).mean() for i in range(L - 1)])
    chosen = None
    for xf in (18, 24, 36):
        m = L - xf
        o = [p.copy() for p in proc[:m]]
        for k in range(xf):
            al = (k + 1) / (xf + 1)
            o[k] = (1 - al) * proc[m + k] + al * proc[k]
        wrap = float(np.abs(o[-1] - o[0]).mean())
        pct = float((adj < wrap).mean() * 100)
        print(f'  {xf/FPS:.2f}s crossfade -> {m/FPS:.2f}s loop, wrap at {pct:.0f}th percentile')
        if pct <= 90 and chosen is None:
            chosen = (xf, o, wrap, pct)
    if chosen is None:
        raise SystemExit('no crossfade hid the seam; regenerate the clip')
    xf, out, wrap, pct = chosen
    print(f'chosen {xf/FPS:.2f}s crossfade, {len(out)/FPS:.2f}s loop, '
          f'wrap {wrap:.2f} at {pct:.0f}th percentile of ordinary frame changes')

    od = tempfile.mkdtemp()
    for i, a in enumerate(out):
        Image.fromarray(np.clip(a, 0, 255).astype('uint8')).save(f'{od}/o{i+1:04d}.png')

    os.makedirs('public/loops', exist_ok=True)
    # H.264 first in the markup: on this footage it beat VP9 on quality per byte.
    # The VP9 is a fallback for clients without H.264 and is never fetched by a
    # browser that takes the mp4.
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS), '-i', f'{od}/o%04d.png',
                    '-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', '-an', f'public/loops/{station}.mp4'], check=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS), '-i', f'{od}/o%04d.png',
                    '-c:v', 'libvpx-vp9', '-crf', '42', '-b:v', '0', '-row-mt', '1',
                    '-an', f'public/loops/{station}.webm'], check=True)
    for ext in ('mp4', 'webm'):
        path = f'public/loops/{station}.{ext}'
        print(f'  {path}: {os.path.getsize(path) / 1e6:.2f} MB')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'welcome')
