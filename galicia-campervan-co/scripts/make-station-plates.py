"""Export one generator-input plate per station.

Each plate is the EXACT frame that station rests on, so a loop generated from it
starts on the frame the scrub already shows — the handover is invisible.

The source's burned-in tool marks are softened out first. That matters more for
generation than for the site: a hard white glyph in the input is an object as far
as an image-to-video model is concerned, and it will happily warp, drift or
animate it. A softly defocused corner just generates as out-of-focus background.
"""
import subprocess, tempfile, os
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

# Paths are relative to the repo root; run as: python3 scripts/make-station-plates.py
SRC = 'raw-footage/van-life-2.mp4'
OUT = 'docs/station-plates'
os.makedirs(OUT, exist_ok=True)

# Timestamps from src/lib/heroTimeline.ts (station frame index / 12fps).
# Numbering matches docs/station-loop-prompts.md
ORDER = {'welcome': 1, 'exterior': 2, 'amenities': 3, 'view': 4, 'closing': 5}

STATIONS = {
    'welcome':   0.000,
    'exterior':  6.757,
    'amenities': 18.936,
    'view':      30.197,
    'closing':   38.038,
}

# Mark union box in 1920x1080 terms, scaled to the 3840 master.
MX, MY = 1580 * 2, 878 * 2
FEATHER = 110
BLUR = 34

tmp = tempfile.mkdtemp()
for name, t in STATIONS.items():
    raw = os.path.join(tmp, f'{name}.png')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{t:.4f}', '-i', SRC,
                    '-frames:v', '1', raw], check=True)
    im = Image.open(raw).convert('RGB')
    W, H = im.size

    # Blurring alone only smears the glyphs into a bright patch — still a
    # high-contrast blob, and still something a video model will treat as an
    # object. Fill the box with real texture instead: mirror the strip directly
    # above it and the strip directly to its left, average the two so lighting
    # gradients from both directions are respected, then blur lightly to settle
    # the seam. The corner content here is grass, sea and van panel, all of which
    # mirror plausibly.
    src = np.asarray(im, dtype=float)

    # Diffusion infill: hold the ring of real pixels around the box fixed and
    # relax the interior towards the average of its neighbours. The result is a
    # smooth extrapolation of the surrounding light — no glyphs, no bright
    # residue, and crucially no structure imported from elsewhere in the frame
    # (mirroring a donor strip dragged the van down into the grass).
    # Solved at 1/8 scale, which is both fast and a guarantee of smoothness.
    SC = 8
    small_im = im.resize((W // SC, H // SC), Image.LANCZOS)
    a = np.asarray(small_im, dtype=float)
    sh, sw = a.shape[:2]
    bx, by = MX // SC, MY // SC

    hole = np.zeros((sh, sw), bool)
    hole[by:, bx:] = True
    work = a.copy()
    # Seed with the mean of the band just outside the hole so it converges fast.
    seed = np.concatenate([a[by - 3:by, bx:].reshape(-1, 3),
                           a[by:, bx - 3:bx].reshape(-1, 3)])
    work[hole] = seed.mean(axis=0)

    for _ in range(600):
        nb = np.zeros_like(work)
        nb[1:-1, 1:-1] = (work[:-2, 1:-1] + work[2:, 1:-1] + work[1:-1, :-2] + work[1:-1, 2:]) / 4
        # Edges of the image have no outside neighbour; mirror instead.
        nb[0], nb[-1], nb[:, 0], nb[:, -1] = nb[1], nb[-2], nb[:, 1], nb[:, -2]
        work[hole] = nb[hole]

    fill_small = Image.fromarray(np.clip(work, 0, 255).astype('uint8'))
    patched = fill_small.resize((W, H), Image.LANCZOS)
    # Deliberately no texture borrowed back from the original here — anything
    # taken from those pixels carries the glyphs' brightness with it. A smooth
    # corner reads as depth-of-field, which is exactly what we want the model
    # to see.

    # Feathered mask so the patch has no visible border.
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rectangle([MX, MY, W, H], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER / 3))
    ImageDraw.Draw(mask).rectangle([MX + FEATHER // 3, MY + FEATHER // 3, W, H], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER / 5))

    plate = Image.composite(patched, im, mask)

    small = plate.resize((1920, 1080), Image.LANCZOS).filter(
        ImageFilter.UnsharpMask(radius=2, percent=60, threshold=3))
    small.save(os.path.join(OUT, f'{ORDER[name]}-{name}.png'))

    # Confirm the glyphs are actually gone from the plate.
    def energy(img):
        a = np.asarray(img.convert('L'), dtype=float)
        r = a[MY:, MX:]
        lap = 4*r[1:-1,1:-1] - r[:-2,1:-1] - r[2:,1:-1] - r[1:-1,:-2] - r[1:-1,2:]
        return np.abs(lap).mean()
    print(f'{name:<10} mark-box energy  before {energy(im):6.2f}  ->  after {energy(plate):5.2f}')

print('\nwrote', OUT)
