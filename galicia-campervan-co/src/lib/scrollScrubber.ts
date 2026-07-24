export interface SequenceConfig {
  /** e.g. "/sequences/hire/" */
  basePath: string;
  frameCount: number;
  /** filename padding, e.g. 4 -> 0001.jpg */
  pad: number;
  ext: string;
}

export interface ScrollScrubberOptions {
  canvas: HTMLCanvasElement;
  /** the tall scroll-distance element the canvas is pinned inside */
  track: HTMLElement;
  sequences: Record<string, SequenceConfig>;
  initialMode: string;
  onProgress?: (progress: number, mode: string) => void;
}

function frameSrc(seq: SequenceConfig, index: number): string {
  const n = String(index + 1).padStart(seq.pad, '0');
  return `${seq.basePath}${n}.${seq.ext}`;
}

/**
 * Drives a <canvas> from scroll position: as the user scrolls through
 * `track`, the canvas draws the frame matching scroll progress (0-1),
 * so the video never visibly "plays" on its own — only scroll moves it.
 */
export function createScrollScrubber(opts: ScrollScrubberOptions) {
  const { canvas, track, sequences } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
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
    const seq = sequences[nextMode];
    if (!seq) throw new Error(`Unknown sequence mode: ${nextMode}`);
    mode = nextMode;
    images = new Array(seq.frameCount);
    loaded = new Array(seq.frameCount).fill(false);
    for (let i = 0; i < seq.frameCount; i++) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        loaded[i] = true;
        if (i === desiredFrame) drawFrame(i, true);
      };
      img.src = frameSrc(seq, i);
      images[i] = img;
    }
    currentFrame = -1;
  }

  function drawFrame(index: number, force = false) {
    desiredFrame = index;
    if (!force && index === currentFrame) return;
    const img = images[index];
    if (!img || !loaded[index]) return; // onload redraws when this frame arrives
    currentFrame = index;

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

  function frameForProgress(p: number): number {
    const seq = sequences[mode];
    const idx = Math.round(p * (seq.frameCount - 1));
    return Math.max(0, Math.min(seq.frameCount - 1, idx));
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
      drawFrame(frameForProgress(progress));
      opts.onProgress?.(progress, mode);
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
      drawFrame(frameForProgress(progress), true);
      opts.onProgress?.(progress, mode);
    },
    getProgress: () => progress,
    getMode: () => mode,
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resizeCanvas);
    },
  };
}
