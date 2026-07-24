import { buildTimeline, type ModeTimeline, type BuiltTimeline, type SectionRange } from './heroTimeline';

export interface ScrollScrubberOptions {
  canvas: HTMLCanvasElement;
  /** the tall scroll-distance element the canvas is pinned inside */
  track: HTMLElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  onProgress?: (progress: number, mode: string, sectionRanges: SectionRange[]) => void;
}

function frameSrc(tl: ModeTimeline, index: number): string {
  const n = String(index + 1).padStart(tl.pad, '0');
  return `${tl.basePath}${n}.${tl.ext}`;
}

/**
 * Drives a <canvas> from scroll position: as the user scrolls through `track`,
 * the canvas draws the frame the timeline maps that scroll progress to — so the
 * video never plays on its own; only scroll moves it, pausing on "hold" frames.
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
  let currentFrame = -1;
  let desiredFrame = 0;
  let progress = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    currentFrame = -1; // force redraw at new size
  }

  function loadSequence(nextMode: string) {
    tl = opts.timelines[nextMode];
    if (!tl) throw new Error(`Unknown sequence mode: ${nextMode}`);
    mode = nextMode;
    built = buildTimeline(tl);
    images = new Array(tl.frameCount);
    loaded = new Array(tl.frameCount).fill(false);
    for (let i = 0; i < tl.frameCount; i++) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        loaded[i] = true;
        if (i === desiredFrame) drawFrame(i, true);
      };
      img.src = frameSrc(tl, i);
      images[i] = img;
    }
    currentFrame = -1;
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
    // frame's onload (i === desiredFrame) will redraw it the moment it arrives.
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

    ctx.drawImage(img, dx, dy, dw, dh);
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
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resizeCanvas);
    },
  };
}
