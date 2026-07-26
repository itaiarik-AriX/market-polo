# Galicia Campervan Co

A cinematic, dual-mode one-pager: **Hire** a campervan or have one **Built** — a
full-screen video that steps between fixed "stations" as you scroll, instead of the
page moving. A pill toggle in the header switches between the two stories; both
share the same station index, layout, and visual language.

> "Galicia Campervan Co" is a working name — swap it in `src/components/Header.astro`
> and `src/pages/index.astro` when the real brand lands.

## Commands

| Command           | Action                                       |
| :---------------- | :------------------------------------------- |
| `npm install`     | Install dependencies                         |
| `npm run dev`     | Dev server at `localhost:4321`               |
| `npm run build`   | Production build to `./dist/`                |
| `npm run preview` | Preview the production build locally         |

## How the scroll works — discrete stations, not continuous scrubbing

Each mode has a small number of fixed "stations" (see `sections` in
`src/lib/heroTimeline.ts`, keyed by a timestamp in seconds). At rest, the site shows
a sharp still image for the current station. Scrolling, swiping, or pressing an
arrow key steps exactly one station forward or back:

- **Forward** plays the real `<video>` natively from the current timestamp to the
  next station's timestamp (sped up via `playbackRate` — see `PLAYBACK_RATE` in
  `src/lib/heroStepper.ts` — since stations can be many real seconds apart in the
  source footage).
- **Backward** manually scrubs `currentTime`, since browsers don't support reverse
  `<video>` playback.
- A single gesture always advances exactly one station — it can never rest
  mid-video. Past the last station, control releases to the page below (the
  enquiry form); scrolling back up resumes on the station last seen.

This replaced an earlier image-sequence approach (hundreds of individual frame
files) — that model made "video not playing" a real risk, since a transition could
land on frames that hadn't finished downloading yet. A single video file streams
progressively and plays natively, which is both smaller and more reliable.

## Assets

- `public/video/<mode>.mp4` + `public/video/<mode>.webm` — the scrub video for each
  mode, in both formats (the browser picks whichever it supports; WebM/VP9 is
  usually smaller at equal quality). Only seen briefly during motion, so it doesn't
  need to match the stills' sharpness — favor a smaller file over maximum quality
  here.
- `public/sequences/<mode>-stations/<id>.webp` — a full-resolution still per
  station, shown at rest. This is where sharpness actually matters, since it's what
  people look at when they pause to read. Swap these freely; filenames must match
  the `id`s in `heroTimeline.ts`.

### Re-encoding the scrub video

```bash
ffmpeg -i source.mp4 -vf "scale=1920:-2" -c:v libvpx-vp9 -crf 32 -b:v 0 \
  -deadline good -cpu-used 4 -row-mt 1 -pix_fmt yuv420p -an public/video/hire.webm
ffmpeg -i source.mp4 -vf "scale=1920:-2" -c:v libx264 -preset slow -crf 22 \
  -pix_fmt yuv420p -movflags +faststart -an public/video/hire.mp4
```

Keep resolution modest (1920px has been plenty) — this file is only visible while
actively moving, and full station stills carry the sharpness burden instead. Update
each station's `time` in `heroTimeline.ts` (seconds into the video) to match new
footage.

### Re-generating a station still

```bash
ffmpeg -i source.mp4 -vf "select='eq(n,FRAME)',scale=3840:-2,unsharp=5:5:0.8:5:5:0.4" \
  -frames:v 1 -c:v libwebp -quality 92 public/sequences/hire-stations/<id>.webp
```

Pick `FRAME` by scanning candidates and preferring the sharpest (motion blur varies
frame-to-frame even in a slow pan) — a quick Laplacian-variance script over a
handful of nearby candidates is more reliable than eyeballing thumbnails.

## Enquiries

No backend, no booking engine: the forms in `src/components/Enquire.astro` compose a
pre-filled email (`mailto:`) to the address at the top of that file. Change `EMAIL`
there (and in `src/pages/index.astro` for the footer) to update it.

## Deploying

See [DEPLOY.md](./DEPLOY.md) — this project auto-deploys via Cloudflare Pages' Git
integration; pushing to the tracked branch is enough.

## Parked: the burned-in tool marks

The source footage carries "Ltx-2" and a Veo sparkle burned into the bottom-right
of every frame (union box x>=1580, y>=878 of each 1920x1080 frame). The frames
currently shipped are untouched, so those marks are visible on landscape screens.
Portrait screens crop them off for free — under `object-fit: cover` they are only
on screen between roughly 1.15:1 and 2.84:1.

The badge's shadow is sized for looks, not coverage: measured 1% reduction in
glyph energy. Ruled out along the way, each with measurements:

- **Translucent shadow/scrim, any size** — 8% transmission of a hard white glyph
  stays legible. Opacity, not spread, is the binding constraint.
- **The logo alone** — line art at 46% coverage; it would need to be ~1980px tall
  (184% of frame height) for its solid areas to span the marks.
- **ffmpeg `delogo`** — vertical smears, because the box touches the frame edge
  and can only interpolate from two sides.
- **Temporal donor patching** — the camera moves 0-170px across 3s while the mark
  is 340px wide at a *fixed* screen position, so no neighbouring frame ever
  reveals what is behind it.
- **Un-compositing** (solving alpha against a clean reference strip) — the alpha
  map isolates the glyphs cleanly but median R^2 is only ~0.25; inverting darkened
  the outlines and looked worse.

Three options remain, all previewed and none chosen yet:

1. Leave as is — marks visible on landscape.
2. **Enamel badge** — fill the badge silhouette opaque so its body covers the
   marks by geometry. Needs ~31vh height, about 2.4x the current badge.
3. **Crop from the 4K master** — trim the bottom-right so there is no mark at all.
   No resolution loss (3840 -> 1920 has headroom), but it clips the van in the
   closing drone shot and loses the wine glasses in the rear-hatch shot.

A baked defocus DID work (96-99% reduction) and is in the git history around
`e793b3f`, but was removed because the softened corner was more objectionable
than the marks.
