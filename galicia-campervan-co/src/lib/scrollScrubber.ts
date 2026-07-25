import { buildTimeline, type ModeTimeline, type BuiltTimeline, type SectionRange } from './heroTimeline';

export interface ScrollScrubberOptions {
  canvas: HTMLCanvasElement;
  /** the tall scroll-distance element the canvas is pinned inside */
  track: HTMLElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  onProgress?: (progress: number, mode: string, sectionRanges: SectionRange[]) => void;
}

const useSmallTier =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;

/**
 * Drives a <canvas> from a hidden <video> as a direct, continuous function of
 * scroll position: the user's own scroll IS the video's position — scrolling
 * down plays it forward, up plays it backward, proportionally. No animated
 * transitions, no "busy" state to wait out; the browser fetches whatever byte
 * range a seek needs on demand, same as any normal scroll-scrub video site —
 * if it hasn't downloaded yet, the frame just doesn't advance further until
 * it catches up, rather than needing any special-cased loading state.
 */
export function createScrollScrubber(opts: ScrollScrubberOptions) {
  const { canvas, track } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let built: BuiltTimeline = buildTimeline(tl);
  let video: HTMLVideoElement = createVideoEl(tl);
  let progress = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let drawLoopId = 0;

  function createVideoEl(timeline: ModeTimeline): HTMLVideoElement {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.position = 'fixed';
    v.style.width = '1px';
    v.style.height = '1px';
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';
    document.body.appendChild(v);

    const base = useSmallTier && timeline.videoBaseSmall ? timeline.videoBaseSmall : timeline.videoBase;
    const webm = document.createElement('source');
    webm.src = `${base}.webm`;
    webm.type = 'video/webm';
    const mp4 = document.createElement('source');
    mp4.src = `${base}.mp4`;
    mp4.type = 'video/mp4';
    v.append(webm, mp4);
    v.load();
    return v;
  }

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    drawCurrentFrame();
  }

  function drawCurrentFrame() {
    const cw = canvas.width;
    const ch = canvas.height;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    try {
      ctx!.drawImage(video, dx, dy, dw, dh);
    } catch {
      // not yet seekable to a drawable frame; next tick retries
    }
  }

  function startDrawLoop() {
    stopDrawLoop();
    function tick() {
      drawCurrentFrame();
      drawLoopId = requestAnimationFrame(tick);
    }
    drawLoopId = requestAnimationFrame(tick);
  }
  function stopDrawLoop() {
    if (drawLoopId) cancelAnimationFrame(drawLoopId);
    drawLoopId = 0;
  }

  function progressFromScroll(): number {
    const rect = track.getBoundingClientRect();
    const scrollableDistance = rect.height - window.innerHeight;
    const scrolled = -rect.top;
    return scrollableDistance > 0 ? Math.max(0, Math.min(1, scrolled / scrollableDistance)) : 0;
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      progress = progressFromScroll();
      const target = built.timeAt(progress);
      // Only issue a new seek once the previous one has resolved — pacing to
      // the decoder's real throughput instead of piling up seek requests
      // faster than it can service them.
      if (!video.seeking && Math.abs(video.currentTime - target) > 0.01) {
        video.currentTime = target;
      }
      opts.onProgress?.(progress, mode, built.sectionRanges);
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  startDrawLoop();

  video.addEventListener('loadedmetadata', () => {
    video.currentTime = built.timeAt(progressFromScroll());
  });
  video.addEventListener('seeked', drawCurrentFrame);

  onScroll();

  return {
    /** Switch sequence, preserving current scroll progress (0-1) across modes. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      const oldVideo = video;
      mode = nextMode;
      tl = opts.timelines[mode];
      built = buildTimeline(tl);
      video = createVideoEl(tl);
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = built.timeAt(progress);
        drawCurrentFrame();
      });
      video.addEventListener('seeked', drawCurrentFrame);
      oldVideo.pause();
      oldVideo.remove();
      opts.onProgress?.(progress, mode, built.sectionRanges);
    },
    getProgress: () => progress,
    getMode: () => mode,
    getSectionRanges: () => built.sectionRanges,
    /** Live internal state for the temporary ?debug=1 on-screen readout. */
    getDebugState() {
      const b = video.buffered;
      return {
        mode,
        progress,
        videoCurrentTime: video.currentTime,
        videoSeeking: video.seeking,
        videoReadyState: video.readyState,
        videoBufferedEnd: b.length ? b.end(b.length - 1) : 0,
      };
    },
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resizeCanvas);
      stopDrawLoop();
    },
  };
}
