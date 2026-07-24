# Galicia Campervan Co

A cinematic, dual-mode one-pager: **Hire** a campervan or have one **Built** — with a
full-screen "video" that scrubs frame-by-frame as you scroll, instead of the page
moving. A pill toggle in the header switches between the two stories; both share the
same scroll position, layout, and visual language.

> "Galicia Campervan Co" is a working name — swap it in `src/components/Header.astro`
> and `src/pages/index.astro` when the real brand lands.

## Commands

| Command           | Action                                       |
| :---------------- | :------------------------------------------- |
| `npm install`     | Install dependencies                         |
| `npm run dev`     | Dev server at `localhost:4321`               |
| `npm run build`   | Production build to `./dist/`                |
| `npm run preview` | Preview the production build locally         |

## How the scroll-video works

- `src/lib/scrollScrubber.ts` maps scroll progress through a tall track (500vh) to a
  frame index, and draws that frame on a pinned full-screen `<canvas>`.
- Frames live in `public/sequences/hire/` and `public/sequences/build/` as numbered
  files (`0001.ext`, `0002.ext`, …).
- Copy blocks in `src/components/Hero.astro` fade in/out at scroll ranges (0–1) you
  set per block in the `copy` object at the top of that file.

## Replacing the placeholder frames with real footage

The current frames are generated placeholders (see
`scripts/generate-placeholder-frames.mjs`). When the real videos are ready:

1. Extract frames with ffmpeg (about 8–12 frames per second of footage is plenty):

   ```bash
   ffmpeg -i hire.mp4 -vf "fps=10,scale=1920:-2" -q:v 3 public/sequences/hire/%04d.jpg
   ffmpeg -i build.mp4 -vf "fps=10,scale=1920:-2" -q:v 3 public/sequences/build/%04d.jpg
   ```

2. Delete the old `.svg` placeholders from those folders.
3. In `src/components/Hero.astro`, update the `sequences` config (bottom `<script>`):
   set `frameCount` to how many frames you extracted and `ext` to `jpg` (or `webp`).
4. `npm run build` and redeploy.

Tip: keep total sequence weight in check — target roughly 3–6 MB per mode. WebP at
quality ~70 usually beats JPEG. Delete `scripts/generate-placeholder-frames.mjs`
once real frames are in.

## Enquiries

No backend, no booking engine: the forms in `src/components/Enquire.astro` compose a
pre-filled email (`mailto:`) to the address at the top of that file. Change `EMAIL`
there (and in `src/pages/index.astro` for the footer) to update it.

## Deploying

See [DEPLOY.md](./DEPLOY.md) — drag-and-drop to Cloudflare Pages, free hosting.
