import {
  buildTimeline,
  resolveSegment,
  segmentCount,
  type ModeTimeline,
  type BuiltTimeline,
  type SectionRange,
} from './heroTimeline';

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

// How close to a segment boundary (as a fraction of the CURRENT segment's own
// progress span) before we start preloading the neighbour — far enough ahead
// that a small segment file has time to arrive before it's actually needed.
const PRELOAD_MARGIN = 0.25;

/**
 * Drives a <canvas> from a hidden <video> as a direct, continuous function of
 * scroll position: the user's own scroll IS the video's position. Unlike a
 * single video spanning the whole timeline, the scrub footage is split into
 * one small file per station-to-station stretch — only the segment currently
 * being scrolled through (plus whichever neighbour is coming up next) is ever
 * loaded, so reaching any point never has to wait on a large, slow download.
 */
export function createScrollScrubber(opts: ScrollScrubberOptions) {
  const { canvas, track } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let built: BuiltTimeline = buildTimeline(tl);
  let progress = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let drawLoopId = 0;

  // Segment video elements, keyed by segment index. Only the active one and
  // its immediate neighbours are kept around; others are evicted to avoid
  // piling up idle <video> elements/connections as the user scrolls far away.
  const segCache = new Map<number, HTMLVideoElement>();
  let activeIndex = -1;

  function segmentSrc(index: number): { webm: string; mp4: string } {
    const base = useSmallTier && tl.videoBaseSmall ? tl.videoBaseSmall : tl.videoBase;
    return { webm: `${base}-seg${index}.webm`, mp4: `${base}-seg${index}.mp4` };
  }

  function createSegmentVideo(index: number): HTMLVideoElement {
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

    const { webm, mp4 } = segmentSrc(index);
    const webmSrc = document.createElement('source');
    webmSrc.src = webm;
    webmSrc.type = 'video/webm';
    const mp4Src = document.createElement('source');
    mp4Src.src = mp4;
    mp4Src.type = 'video/mp4';
    v.append(webmSrc, mp4Src);
    v.load();
    return v;
  }

  function getOrCreateSegment(index: number): HTMLVideoElement {
    const clamped = Math.max(0, Math.min(segmentCount(tl) - 1, index));
    let v = segCache.get(clamped);
    if (!v) {
      v = createSegmentVideo(clamped);
      segCache.set(clamped, v);
    }
    return v;
  }

  function evictExcept(keep: Set<number>) {
    for (const [idx, v] of segCache) {
      if (!keep.has(idx)) {
        v.pause();
        v.remove();
        segCache.delete(idx);
      }
    }
  }

  function activeVideo(): HTMLVideoElement | undefined {
    return segCache.get(activeIndex);
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
    const video = activeVideo();
    if (!video) return;
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

  function applyProgress(p: number) {
    const globalTime = built.timeAt(p);
    const { index, localTime } = resolveSegment(tl, globalTime);

    if (index !== activeIndex) {
      activeIndex = index;
      const keep = new Set([index, index - 1, index + 1]);
      evictExcept(keep);
    }

    const video = getOrCreateSegment(index);
    if (!video.seeking && Math.abs(video.currentTime - localTime) > 0.01) {
      video.currentTime = localTime;
    }

    // Preload whichever neighbour we're approaching, so crossing the boundary
    // doesn't start a fresh download from zero right when it's needed.
    const segStartGlobal = tl.sections[index].time;
    const segEndGlobal = tl.sections[index + 1]?.time ?? segStartGlobal;
    const span = segEndGlobal - segStartGlobal;
    if (span > 0) {
      const localFrac = (globalTime - segStartGlobal) / span;
      if (localFrac > 1 - PRELOAD_MARGIN) getOrCreateSegment(index + 1);
      else if (localFrac < PRELOAD_MARGIN) getOrCreateSegment(index - 1);
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      progress = progressFromScroll();
      applyProgress(progress);
      opts.onProgress?.(progress, mode, built.sectionRanges);
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  startDrawLoop();
  onScroll();

  return {
    /** Switch sequence, preserving current scroll progress (0-1) across modes. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      evictExcept(new Set());
      activeIndex = -1;
      mode = nextMode;
      tl = opts.timelines[mode];
      built = buildTimeline(tl);
      applyProgress(progress);
      opts.onProgress?.(progress, mode, built.sectionRanges);
    },
    getProgress: () => progress,
    getMode: () => mode,
    getSectionRanges: () => built.sectionRanges,
    /** Live internal state for the temporary ?debug=1 on-screen readout. */
    getDebugState() {
      const video = activeVideo();
      const b = video?.buffered;
      return {
        mode,
        progress,
        segmentIndex: activeIndex,
        videoCurrentTime: video?.currentTime ?? 0,
        videoSeeking: video?.seeking ?? false,
        videoReadyState: video?.readyState ?? 0,
        videoBufferedEnd: b && b.length ? b.end(b.length - 1) : 0,
      };
    },
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resizeCanvas);
      stopDrawLoop();
      evictExcept(new Set());
    },
  };
}
