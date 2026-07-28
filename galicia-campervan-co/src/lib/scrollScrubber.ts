import { buildTimeline, type ModeTimeline, type BuiltTimeline, type SectionRange } from './heroTimeline';

export interface ScrollScrubberOptions {
  canvas: HTMLCanvasElement;
  /** the tall scroll-distance element the canvas is pinned inside */
  track: HTMLElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  onProgress?: (progress: number, mode: string, sectionRanges: SectionRange[]) => void;
}

// Small screens load the lighter frame set (if the mode provides one), so phones
// stay fast while big screens get the full-resolution sequence. Decided once at
// load — a viewport that starts small keeps the light set even if later resized.
const useSmallTier =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;

// A phone held upright cover-fits a 16:9 frame to about a quarter of its width
// and upscales it roughly 4x — on the opening frame that crops the van out of
// shot entirely. The portrait tier is the same footage recut as a 9:16 window
// that pans between stations, so each one stays composed.
//
// Gated on orientation as well as width: a small LANDSCAPE viewport wants the
// wide frames, and would be badly served by a tall crop.
const usePortraitTier =
  typeof window !== 'undefined' &&
  window.matchMedia('(max-width: 820px) and (orientation: portrait)').matches;

/** Which frame folder this client should load, widest match first. */
export function tierFor(tl: ModeTimeline): string {
  if (usePortraitTier && tl.basePathPortrait) return tl.basePathPortrait;
  if (useSmallTier && tl.basePathSmall) return tl.basePathSmall;
  return tl.basePath;
}

// How many images to have in flight at once. Browsers cap concurrent requests
// per origin anyway (~6); keeping our own queue slightly above that keeps the
// pipe full without dumping hundreds of requests the browser must itself
// reorder — which is what made the very first version's opening seconds rough.
const MAX_IN_FLIGHT = 8;

function frameSrc(tl: ModeTimeline, index: number): string {
  const n = String(index + 1).padStart(tl.pad, '0');
  const base = tierFor(tl);
  return `${base}${n}.${tl.ext}`;
}

/**
 * Drives a <canvas> from scroll position: as the user scrolls through `track`,
 * the canvas draws the frame the timeline maps that scroll progress to. The
 * video never plays on its own and nothing ever scrolls the page — the user's
 * scroll position IS the position in the sequence, so control is always theirs.
 *
 * Frames are independent images, so drawing one can never stall on a seek the
 * way a <video> can; a frame that hasn't arrived yet simply falls back to the
 * nearest one that has. They are fetched in priority passes (stations first,
 * then a coarse sweep of the whole timeline, then progressively finer) so the
 * entire scrub is usable within a couple of seconds and only sharpens from
 * there, rather than waiting on the full sequence.
 */
export function createScrollScrubber(opts: ScrollScrubberOptions) {
  const { canvas, track } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let built: BuiltTimeline = buildTimeline(tl);
  let images: HTMLImageElement[] = [];
  let loaded: boolean[] = [];
  let loadedCount = 0;
  let currentFrame = -1;
  let desiredFrame = 0;
  let progress = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let loadToken = 0; // invalidates an in-progress load when the mode changes

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    currentFrame = -1; // force redraw at new size
    drawFrame(desiredFrame, true);
  }

  /**
   * Build the fetch order: station frames first (so every resting point is
   * correct immediately), then every 8th frame across the whole timeline (the
   * entire scrub becomes usable), then every 4th, every 2nd, and finally the
   * rest — each pass roughly halving the gap between loaded frames.
   */
  function loadOrder(count: number, stationFrames: number[]): number[] {
    const order: number[] = [];
    const seen = new Set<number>();
    const push = (i: number) => {
      if (i >= 0 && i < count && !seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    };
    for (const f of stationFrames) push(f);
    for (const stride of [8, 4, 2, 1]) {
      for (let i = 0; i < count; i += stride) push(i);
    }
    return order;
  }

  function loadSequence(nextMode: string) {
    tl = opts.timelines[nextMode];
    if (!tl) throw new Error(`Unknown sequence mode: ${nextMode}`);
    mode = nextMode;
    built = buildTimeline(tl);
    images = new Array(tl.frameCount);
    loaded = new Array(tl.frameCount).fill(false);
    loadedCount = 0;
    currentFrame = -1;

    const myToken = ++loadToken;
    const order = loadOrder(tl.frameCount, built.stationFrames);
    const queued = new Array(tl.frameCount).fill(false);
    let next = 0;
    let inFlight = 0;
    let alternate = 0;

    // Pick the next frame to fetch. Alternates between two strategies so we get
    // both properties we need:
    //   - GLOBAL coverage, walking the stride order above, so no region of the
    //     timeline is ever left blank if the user jumps somewhere unexpected;
    //   - LOCAL density around wherever the user actually is right now, so the
    //     stretch they're scrubbing through fills in first and stops looking
    //     coarse. Without this the loader can be busy fetching frame 12 while
    //     the user is scrubbing around frame 300.
    function pickNext(): number {
      const wantLocal = (alternate++ & 1) === 0;
      if (wantLocal) {
        const WINDOW = 40;
        for (let d = 0; d <= WINDOW; d++) {
          const a = desiredFrame - d;
          const b = desiredFrame + d;
          if (a >= 0 && !queued[a]) return a;
          if (b < tl.frameCount && !queued[b]) return b;
        }
      }
      while (next < order.length && queued[order[next]]) next++;
      if (next < order.length) return order[next];
      // global order exhausted — fall back to any remaining unqueued frame
      for (let i = 0; i < tl.frameCount; i++) if (!queued[i]) return i;
      return -1;
    }

    function pump() {
      if (myToken !== loadToken) return; // a mode switch superseded this load
      while (inFlight < MAX_IN_FLIGHT) {
        const i = pickNext();
        if (i < 0) break;
        queued[i] = true;
        inFlight++;
        const img = new Image();
        img.decoding = 'async';
        const done = () => {
          if (myToken !== loadToken) return;
          inFlight--;
          pump();
        };
        img.onload = () => {
          if (myToken !== loadToken) return;
          loaded[i] = true;
          loadedCount++;
          // Redraw if this is the frame we actually want, or if it's a closer
          // match than whatever fallback is currently on screen.
          if (i === desiredFrame || Math.abs(i - desiredFrame) < Math.abs(currentFrame - desiredFrame)) {
            drawFrame(desiredFrame, true);
          }
          done();
        };
        img.onerror = done;
        img.src = frameSrc(tl, i);
        images[i] = img;
      }
    }
    pump();
  }

  function nearestLoaded(index: number): number {
    if (loaded[index]) return index;
    // search outward so we draw the closest available frame, never a black flash
    for (let d = 1; d < images.length; d++) {
      if (index - d >= 0 && loaded[index - d]) return index - d;
      if (index + d < images.length && loaded[index + d]) return index + d;
    }
    return -1;
  }

  function drawFrame(index: number, force = false) {
    desiredFrame = index;
    if (!force && index === currentFrame) return;
    const drawIdx = nearestLoaded(index);
    if (drawIdx === -1) return; // nothing loaded yet; onload will redraw
    const img = images[drawIdx];
    if (!img) return;
    // Track what we actually drew. If it's a fallback (≠ desired), the exact
    // frame's onload will redraw it the moment it arrives.
    currentFrame = drawIdx;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    // object-fit: cover
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx!.drawImage(img, dx, dy, dw, dh);
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const rect = track.getBoundingClientRect();
      const scrollableDistance = rect.height - window.innerHeight;
      const scrolled = -rect.top;
      progress = scrollableDistance > 0
        ? Math.max(0, Math.min(1, scrolled / scrollableDistance))
        : 0;
      drawFrame(built.frameAt(progress));
      opts.onProgress?.(progress, mode, built.sectionRanges);
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  loadSequence(opts.initialMode);
  onScroll();

  return {
    /** Switch sequence, preserving current scroll progress (0-1) across modes. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      loadSequence(nextMode);
      drawFrame(built.frameAt(progress), true);
      opts.onProgress?.(progress, mode, built.sectionRanges);
    },
    getProgress: () => progress,
    getMode: () => mode,
    /** Live internal state for the temporary ?debug=1 on-screen readout. */
    getDebugState() {
      return {
        mode,
        progress,
        desiredFrame,
        drawnFrame: currentFrame,
        loadedCount,
        frameCount: tl.frameCount,
      };
    },
    destroy() {
      loadToken++;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resizeCanvas);
    },
  };
}
