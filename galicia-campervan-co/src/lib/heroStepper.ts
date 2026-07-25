import { segmentCount, type ModeTimeline } from './heroTimeline';

export interface HeroStepperOptions {
  canvas: HTMLCanvasElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  reduceMotion: boolean;
  /** called whenever the resting station changes (after a transition completes, or a mode switch) */
  onStation: (mode: string, stationId: string, index: number) => void;
  /** called the instant a station-to-station move begins, so overlays (the sharp
   *  still + copy) can fade out and reveal the playing video underneath */
  onTransitionStart?: (mode: string) => void;
  /** called when a move's seek is genuinely taking a while (waiting=true), and
   *  again once it resolves (waiting=false) — see watchForSlowSeek() below. */
  onBufferWait?: (mode: string, waiting: boolean) => void;
}

const SETTLE_MS = 260; // keep drawing the correct frame under the still's 0.22s crossfade,
                       // and act as the cooldown before the next input is accepted
const DEFAULT_TRANSITION_S = 2.4; // fallback when a section doesn't set its own duration

function transitionMs(section: { transition?: number }): number {
  return (section.transition ?? DEFAULT_TRANSITION_S) * 1000;
}

const useSmallTier =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;

/**
 * Drives a <canvas> as a set of discrete "stations": at rest it shows one
 * station's frame; a step in either direction animates the video from the
 * current station to the target by driving `currentTime` ourselves each frame
 * (never native play()), so it always RESUMES from where it is and behaves
 * identically forward, backward, and across every browser.
 *
 * Rather than one video spanning the whole timeline, the footage is split
 * into one small file per station-to-station stretch (segment `i` covers
 * station `i` to station `i+1`) — a move only ever needs that one small file,
 * not a slice of one large one, and the two segments adjacent to the current
 * resting station are kept preloaded so a step in either direction is instant
 * rather than a cold load.
 */
export function createHeroStepper(opts: HeroStepperOptions) {
  const { canvas, reduceMotion } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let stationIndex = 0;
  let busy = false;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let drawLoopId = 0;
  let activeFrom: number | null = null;
  let activeTo: number | null = null;

  const segCache = new Map<number, HTMLVideoElement>();
  let drawFromIndex = -1; // which cached segment's video the draw loop currently reads from

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
    v.addEventListener('seeked', () => {
      if (drawFromIndex === index) drawCurrentFrame();
    });
    return v;
  }

  function getOrCreateSegment(index: number): HTMLVideoElement | undefined {
    if (index < 0 || index >= segmentCount(tl)) return undefined;
    let v = segCache.get(index);
    if (!v) {
      v = createSegmentVideo(index);
      segCache.set(index, v);
    }
    return v;
  }

  // Keep only the segments adjacent to the current resting station loaded —
  // the one ending here and the one starting here — so either direction is
  // ready to go instantly; anything else is evicted.
  function preloadNeighbors(station: number) {
    const keep = new Set<number>();
    if (station - 1 >= 0) keep.add(station - 1);
    if (station < segmentCount(tl)) keep.add(station);
    for (const idx of keep) getOrCreateSegment(idx);
    for (const [idx, v] of segCache) {
      if (!keep.has(idx)) {
        v.pause();
        v.remove();
        segCache.delete(idx);
      }
    }
  }

  function withMetadata(video: HTMLVideoElement, cb: () => void) {
    if (video.readyState >= 1 && !Number.isNaN(video.duration)) {
      cb();
      return;
    }
    video.addEventListener('loadedmetadata', () => cb(), { once: true });
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
    const video = drawFromIndex >= 0 ? segCache.get(drawFromIndex) : undefined;
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
      // video not yet seekable to a drawable frame; next tick will retry
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

  function currentStationId(): string {
    return tl.sections[stationIndex].id;
  }

  // Shows the loading cue only if a seek is ACTUALLY taking a while — driven
  // by `video.seeking` itself. Setting `currentTime` is what makes the browser
  // fetch whatever byte range it needs; only surface a "loading" indicator if
  // that seek is still unresolved past a short grace period, and hide it the
  // moment it resolves. With each segment now only a few MB, this should
  // rarely fire at all — but stays as a safety net for a genuinely slow link.
  function watchForSlowSeek(video: HTMLVideoElement) {
    let shown = false;
    let seekingSince: number | null = null;
    function tick() {
      if (!busy) {
        if (shown) opts.onBufferWait?.(mode, false);
        return;
      }
      if (video.seeking) {
        if (seekingSince === null) seekingSince = performance.now();
        if (!shown && performance.now() - seekingSince > 400) {
          opts.onBufferWait?.(mode, true);
          shown = true;
        }
      } else {
        seekingSince = null;
        if (shown) {
          opts.onBufferWait?.(mode, false);
          shown = false;
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Clears `busy` once BOTH a minimum cooldown has elapsed AND the video has
  // no seek in flight — never on a fixed timer alone, so a next scroll can
  // never race against an unresolved seek from the previous one. A hard
  // safety-net timeout still force-clears busy if a seek genuinely never
  // resolves, so input can't lock up.
  function waitForSettle(video: HTMLVideoElement, onDone: () => void) {
    let timerDone = false;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      video.removeEventListener('seeked', maybeFinish);
      onDone();
    }
    function maybeFinish() {
      if (timerDone && !video.seeking) finish();
    }
    window.setTimeout(() => { timerDone = true; maybeFinish(); }, SETTLE_MS);
    window.setTimeout(finish, SETTLE_MS + 6000);
    video.addEventListener('seeked', maybeFinish);
    maybeFinish();
  }

  // Instantly rest on a station (no animation) — used for the initial render
  // and after a mode switch. Either the segment ending here (at its full
  // duration) or the one starting here (at 0) shows the identical source
  // frame; whichever is already cached is preferred.
  function settleInstantlyAt(index: number) {
    preloadNeighbors(index);
    const endSeg = index - 1 >= 0 ? segCache.get(index - 1) : undefined;
    const startSeg = index < segmentCount(tl) ? segCache.get(index) : undefined;
    const video = endSeg ?? startSeg;
    if (!video) return;
    const useEnd = video === endSeg;
    withMetadata(video, () => {
      video.currentTime = useEnd ? (video.duration || 0) : 0;
      drawFromIndex = useEnd ? index - 1 : index;
      stationIndex = index;
      drawCurrentFrame();
      opts.onStation(mode, currentStationId(), stationIndex);
    });
  }

  // Common "land on a station" routine, shared by every move. Deterministically
  // seeks to the exact station frame (so the resting video frame is pixel-for-
  // pixel the sharp still), fires onStation so the still begins its snappy
  // fade-in, and keeps the video's correct frame under the crossfade until the
  // still has fully covered.
  //
  // The correction is direction-aware: browsers don't seek frame-exactly, so
  // the decoder can land a hair PAST toTime in the direction of travel. Only
  // correct if we haven't yet reached toTime in that direction — never seek
  // the opposite way, since that's a visible snap-back against the motion the
  // user just watched (the sub-frame overshoot itself is imperceptible).
  function landOn(targetIndex: number, segIndex: number, video: HTMLVideoElement, toTime: number, forward: boolean) {
    video.pause();
    const short = forward ? video.currentTime < toTime - 0.001 : video.currentTime > toTime + 0.001;
    if (short) video.currentTime = toTime;
    stationIndex = targetIndex;
    drawFromIndex = segIndex;
    drawCurrentFrame();
    activeFrom = null;
    activeTo = null;
    opts.onStation(mode, currentStationId(), stationIndex);
    waitForSettle(video, () => {
      stopDrawLoop();
      drawCurrentFrame();
      preloadNeighbors(stationIndex);
      busy = false;
    });
  }

  // Animate from the current station to the target by stepping `currentTime`
  // ourselves each frame — NOT native play(). Segment `i` connects station i
  // and station i+1, so the relevant file for ANY move is simply the segment
  // at min(current, target); forward plays it start-to-end, backward end-to-
  // start. Works identically in every browser and always resumes correctly.
  function moveTo(targetIndex: number) {
    const dir: 1 | -1 = targetIndex > stationIndex ? 1 : -1;
    const segIndex = Math.min(stationIndex, targetIndex);
    const video = getOrCreateSegment(segIndex);
    if (!video) return;

    busy = true;
    withMetadata(video, () => {
      const duration = video.duration || 0;
      const fromTime = dir === 1 ? 0 : duration;
      const toTime = dir === 1 ? duration : 0;
      const forward = dir === 1;

      if (reduceMotion) {
        landOn(targetIndex, segIndex, video, toTime, forward);
        return;
      }

      activeFrom = fromTime;
      activeTo = toTime;
      opts.onTransitionStart?.(mode);
      drawFromIndex = segIndex;
      startDrawLoop();
      watchForSlowSeek(video);
      video.pause();
      video.currentTime = fromTime;

      const durMs = transitionMs(tl.sections[Math.max(stationIndex, targetIndex)]);
      const t0 = performance.now();
      function step() {
        const t = Math.min(1, (performance.now() - t0) / durMs);
        if (t >= 1) {
          landOn(targetIndex, segIndex, video, toTime, forward);
          return;
        }
        if (!video.seeking) {
          const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
          video.currentTime = fromTime + (toTime - fromTime) * eased;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  settleInstantlyAt(0);

  return {
    isBusy: () => busy,
    getStationIndex: () => stationIndex,
    getStationCount: () => tl.sections.length,
    getMode: () => mode,
    /** Live internal state for the temporary ?debug=1 on-screen readout — lets a
     *  screenshot capture exactly what's happening instead of a description. */
    getDebugState() {
      const video = drawFromIndex >= 0 ? segCache.get(drawFromIndex) : undefined;
      const b = video?.buffered;
      return {
        mode,
        stationIndex,
        stationId: currentStationId(),
        busy,
        activeFrom,
        activeTo,
        videoCurrentTime: video?.currentTime ?? 0,
        videoSeeking: video?.seeking ?? false,
        videoReadyState: video?.readyState ?? 0,
        videoBufferedEnd: b && b.length ? b.end(b.length - 1) : 0,
      };
    },
    /** Step forward (dir=1) or back (dir=-1). No-op if already busy or at an end. */
    step(dir: 1 | -1): boolean {
      if (busy) return false;
      const target = stationIndex + dir;
      if (target < 0 || target >= tl.sections.length) return false;
      moveTo(target);
      return true;
    },
    /** Switch sequence, keeping the same station index, no animation. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      const nextTl = opts.timelines[nextMode];
      const keepIndex = Math.min(stationIndex, nextTl.sections.length - 1);
      stopDrawLoop();
      for (const [, v] of segCache) {
        v.pause();
        v.remove();
      }
      segCache.clear();
      drawFromIndex = -1;
      mode = nextMode;
      tl = nextTl;
      settleInstantlyAt(keepIndex);
    },
    destroy() {
      window.removeEventListener('resize', resizeCanvas);
      stopDrawLoop();
      for (const [, v] of segCache) {
        v.pause();
        v.remove();
      }
      segCache.clear();
    },
  };
}
