#!/usr/bin/env python3
"""Build the hero badge's two assets from a single source export.

Produces `public/logo-light.webp` (the visible mark) and `public/logo-glow.webp`
(the silhouette both shadow layers are drawn from). They are a matched pair: the
shadow is the badge's OWN shape, so replacing one without the other leaves the
new badge casting the old badge's outline.

Recovering the alpha
--------------------
The supplied export is a JPEG, so it has no alpha channel — the artwork's
transparency was flattened onto the editor's 46px preview checkerboard, which is
now baked into the pixels as two greys (~204 and ~255).

That is keyable, but NOT by keying those greys globally: the lettering, the sun
and the sky highlights are also near-white, and a global key eats them. So the
background is found by flood-filling inward from the border — only checker that
is CONNECTED to the edge is removed, and anything enclosed by the badge survives
whatever colour it is.

JPEG then leaves a ringing fringe along the badge's hard outline against the
checker, which reads as a pale halo once composited over dark footage. The alpha
is eroded a couple of pixels to cut it back, then feathered a pixel for
antialiasing.

Reproducing the shadow
----------------------
Measured off the shipped `logo-glow.webp` so the CSS keeps behaving identically:
its alpha=50% contour lands exactly on the badge outline, centred on a canvas
1.543x the mark's, falling to ~0 by 728px of 864. That is a Gaussian of about
sigma = 5.2% of the canvas width. Core colour is #49433f, not black — it is
composited with mix-blend-mode: multiply, so it tints rather than paints.

Usage:  python3 scripts/make-logo-assets.py --src docs/<export>.jpeg
"""
import argparse
import os

import numpy as np
from PIL import Image, ImageFilter

# Measured from the assets this replaces - see the module docstring.
GLOW_SCALE = 864 / 560      # glow canvas relative to the mark's
GLOW_SIGMA_FRAC = 45 / 864  # gaussian sigma as a fraction of the glow canvas
GLOW_RGB = (73, 67, 63)


def flood_from_border(mask):
    """Which of `mask` is reachable from the image edge, 4-connected.

    Written out rather than using PIL's floodfill, which compares each pixel to
    the SEED'S VALUE: on a checkerboard that stops dead at the first square of
    the other grey, and it filled exactly one pixel here. Scanline runs rather
    than per-pixel BFS, because this is a 4.2M-pixel image and most of it is
    background.
    """
    h, w = mask.shape
    seen = np.zeros((h, w), bool)
    stack = [(x, 0) for x in np.nonzero(mask[0])[0]]
    stack += [(x, h - 1) for x in np.nonzero(mask[h - 1])[0]]
    stack += [(0, y) for y in np.nonzero(mask[:, 0])[0]]
    stack += [(w - 1, y) for y in np.nonzero(mask[:, w - 1])[0]]

    while stack:
        x, y = stack.pop()
        if seen[y, x] or not mask[y, x]:
            continue
        row, srow = mask[y], seen[y]
        xl = x
        while xl > 0 and row[xl - 1] and not srow[xl - 1]:
            xl -= 1
        xr = x
        while xr < w - 1 and row[xr + 1] and not srow[xr + 1]:
            xr += 1
        srow[xl:xr + 1] = True
        for ny in (y - 1, y + 1):
            if 0 <= ny < h:
                span = mask[ny, xl:xr + 1] & ~seen[ny, xl:xr + 1]
                idx = np.nonzero(span)[0]
                if idx.size:
                    breaks = np.nonzero(np.diff(idx) > 1)[0]
                    for s in np.concatenate(([idx[0]], idx[breaks + 1])):
                        stack.append((xl + int(s), ny))
    return seen


def background_alpha(im, grey_tol=18, bright=185, erode=2, feather=1.0):
    """Alpha for the artwork, with the checkerboard flood-filled away."""
    a = np.asarray(im.convert('RGB')).astype(np.int16)
    spread = a.max(2) - a.min(2)                 # 0 for a pure grey
    cand = (spread < grey_tol) & (a.mean(2) > bright)

    # Only checker CONNECTED to the edge goes, so anything the badge encloses
    # survives however light it is.
    outside = flood_from_border(cand)

    alpha = Image.fromarray(np.where(outside, 0, 255).astype(np.uint8), 'L')
    # Open away specks the checker leaves behind, then pull the edge in off the
    # JPEG ringing, then soften by a pixel so it does not stair-step.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    for _ in range(erode):
        alpha = alpha.filter(ImageFilter.MinFilter(3))
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    return alpha


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', default='public')
    # Matches the height of the asset being replaced, so rendered sharpness is
    # unchanged (the badge is laid out by height).
    ap.add_argument('--mark-height', type=int, default=534)
    ap.add_argument('--erode', type=int, default=2)
    args = ap.parse_args()

    src = Image.open(args.src)
    print(f'source {src.size} {src.mode}')

    alpha = background_alpha(src, erode=args.erode)
    rgba = src.convert('RGBA')
    rgba.putalpha(alpha)

    box = rgba.getbbox()                      # trims on alpha
    cut = rgba.crop(box)
    print(f'trimmed to {cut.size} at {box}  aspect {cut.size[0] / cut.size[1]:.4f}')

    # ---- the visible mark -------------------------------------------------
    mh = args.mark_height
    mw = max(1, round(cut.size[0] * mh / cut.size[1]))
    mark = cut.resize((mw, mh), Image.LANCZOS)
    os.makedirs(args.out, exist_ok=True)
    mark.save(os.path.join(args.out, 'logo-light.webp'), quality=92, method=6)
    print(f'logo-light.webp {mark.size}')

    # ---- the shadow silhouette -------------------------------------------
    # The badge is a solid shape, so its own alpha IS the silhouette; the old
    # logo needed strokes closing and the exterior flood-filling because it was
    # open line art.
    gw, gh = round(mw * GLOW_SCALE), round(mh * GLOW_SCALE)
    glow = Image.new('RGBA', (gw, gh), GLOW_RGB + (0,))
    shape = Image.new('L', (gw, gh), 0)
    shape.paste(mark.getchannel('A'), ((gw - mw) // 2, (gh - mh) // 2))
    shape = shape.filter(ImageFilter.GaussianBlur(GLOW_SIGMA_FRAC * gw))
    glow.putalpha(shape)
    glow.save(os.path.join(args.out, 'logo-glow.webp'), quality=90, method=6)
    print(f'logo-glow.webp  {glow.size}  sigma {GLOW_SIGMA_FRAC * gw:.1f}px')

    print(f'\naspect-ratio for .hero-brand: {mw} / {mh}')


if __name__ == '__main__':
    main()
