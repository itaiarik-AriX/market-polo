import type { ModeTimeline } from './heroTimeline';

export interface HeroStepperOptions {
  canvas: HTMLCanvasElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  reduceMotion: boolean;
  /** called whenever the resting station changes (after a transition completes, or a mode switch) */
  onStation: (mode: string, stationId: string, index: number) => void;
}

const TRANSITION_MS = 900;
const SETTLE_MS = 280; // extra cooldown after a transition before accepting new input

function frameSrc(tl: ModeTimeline, index: number, small: boolean): string {
  const n = String(index + 1).padStart(tl.pad, '0');
  const base = small && tl.basePathSmall ? tl.basePathSmall : tl.basePath;
  return `${base}${n}.${tl.ext}`;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Drives a <canvas> as a set of discrete "stations": at rest it shows one
 * station's frame; a step forward/back auto-plays through the frames between
 * the current and target station, then stops exactly on the target — scroll
 * position never determines the frame, so it can never rest mid-video.
 */
export function createHeroStepper(opts: HeroStepperOptions) {
  const { canvas, reduceMotion } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  const useSmallTier =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let images: HTMLImageElement[] = [];
  let loaded: boolean[] = [];
  let currentFrame = -1;
  let desiredFrame = 0;
  let stationIndex = 0;
  let busy = false; // true while transitioning + settle cooldown
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    currentFrame = -1;
    drawFrame(desiredFrame, true);
  }

  function loadSequence(nextMode: string) {
    tl = opts.timelines[nextMode];
    if (!tl) throw new Error(`Unknown sequence mode: ${nextMode}`);
    mode = nextMode;
    images = new Array(tl.frameCount);
    loaded = new Array(tl.frameCount).fill(false);
    for (let i = 0; i < tl.frameCount; i++) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        loaded[i] = true;
        if (i === desiredFrame) drawFrame(i, true);
      };
      img.src = frameSrc(tl, i, useSmallTier);
      images[i] = img;
    }
    currentFrame = -1;
  }

  function nearestLoaded(index: number): number {
    if (loaded[index]) return index;
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
    if (drawIdx === -1) return;
    const img = images[drawIdx];
    if (!img) return;
    currentFrame = drawIdx;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function currentStationId(): string {
    return tl.sections[stationIndex].id;
  }

  function settleAt(index: number) {
    stationIndex = index;
    drawFrame(tl.sections[index].frame, true);
    opts.onStation(mode, currentStationId(), stationIndex);
  }

  function animateTo(targetIndex: number) {
    const fromFrame = tl.sections[stationIndex].frame;
    const toFrame = tl.sections[targetIndex].frame;

    if (reduceMotion || fromFrame === toFrame) {
      settleAt(targetIndex);
      return;
    }

    busy = true;
    const t0 = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - t0) / TRANSITION_MS);
      const eased = easeInOutCubic(t);
      const f = Math.round(fromFrame + (toFrame - fromFrame) * eased);
      drawFrame(f);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        stationIndex = targetIndex;
        opts.onStation(mode, currentStationId(), stationIndex);
        window.setTimeout(() => { busy = false; }, SETTLE_MS);
      }
    }
    requestAnimationFrame(step);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  loadSequence(opts.initialMode);
  drawFrame(tl.sections[0].frame, true);
  // Announce the initial station once images start loading so copy/still show immediately.
  opts.onStation(mode, currentStationId(), stationIndex);

  return {
    isBusy: () => busy,
    getStationIndex: () => stationIndex,
    getStationCount: () => tl.sections.length,
    getMode: () => mode,
    /** Step forward (dir=1) or back (dir=-1). No-op if already busy or at an end. */
    step(dir: 1 | -1): boolean {
      if (busy) return false;
      const target = stationIndex + dir;
      if (target < 0 || target >= tl.sections.length) return false;
      animateTo(target);
      return true;
    },
    /** Switch sequence, keeping the same station index, no animation. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      const keepIndex = Math.min(stationIndex, opts.timelines[nextMode].sections.length - 1);
      loadSequence(nextMode);
      stationIndex = keepIndex;
      drawFrame(tl.sections[stationIndex].frame, true);
      opts.onStation(mode, currentStationId(), stationIndex);
    },
    destroy() {
      window.removeEventListener('resize', resizeCanvas);
    },
  };
}
