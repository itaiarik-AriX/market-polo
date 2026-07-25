import type { ModeTimeline } from './heroTimeline';

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
 * Drives a <canvas> from a hidden <video> as a set of discrete "stations": at
 * rest it shows one station's frame; a step in either direction animates the
 * video from the current station to the target by driving `currentTime`
 * ourselves each frame (never native play()), so it always RESUMES from where
 * it is and behaves identically forward, backward, and across every browser.
 */
export function createHeroStepper(opts: HeroStepperOptions) {
  const { canvas, reduceMotion } = opts;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  let mode = opts.initialMode;
  let tl: ModeTimeline = opts.timelines[mode];
  let video: HTMLVideoElement = createVideoEl(tl);
  let stationIndex = 0;
  let busy = false;
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
    // WebM/VP9 first (smaller at equal quality where supported), MP4/H.264 as the
    // universally-compatible fallback — the browser picks the first it can play.
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

  function settleAt(index: number, time: number) {
    stationIndex = index;
    video.pause();
    video.currentTime = time;
    stopDrawLoop();
    drawCurrentFrame();
    opts.onStation(mode, currentStationId(), stationIndex);
  }

  // Common "land on a station" routine, shared by every move. Deterministically
  // seeks to the exact station frame (so the resting video frame is pixel-for-pixel
  // the sharp still — no positional jump when the still crossfades in, and no
  // dependence on where fast playback happened to stop), fires onStation so the
  // still begins its snappy fade-in, and keeps the video's correct frame under the
  // crossfade until the still has fully covered.
  function landOn(targetIndex: number, toTime: number) {
    video.pause();
    if (Math.abs(video.currentTime - toTime) > 0.001) video.currentTime = toTime;
    stationIndex = targetIndex;
    drawCurrentFrame();
    opts.onStation(mode, currentStationId(), stationIndex);
    window.setTimeout(() => {
      stopDrawLoop();
      drawCurrentFrame();
      busy = false;
    }, SETTLE_MS);
  }

  // Animate the video from wherever it currently is to a target station by
  // stepping `currentTime` ourselves each frame — NOT native play(). This works
  // identically in every browser (Chrome/Safari/Firefox), always RESUMES from the
  // current position (we read `fromTime` and interpolate from it — never a
  // browser-specific play()-from-0 quirk), and runs both forward and backward.
  // We only issue a new seek when the previous one has landed (`!video.seeking`),
  // pacing to the decoder's real throughput (cheap now thanks to dense keyframes).
  function moveTo(targetIndex: number) {
    const fromTime = video.currentTime;
    const toTime = tl.sections[targetIndex].time;
    // The segment's duration lives on the higher-index of the two stations.
    const dur = transitionMs(tl.sections[Math.max(stationIndex, targetIndex)]);

    if (reduceMotion || Math.abs(toTime - fromTime) < 0.001) {
      settleAt(targetIndex, toTime);
      return;
    }

    busy = true;
    opts.onTransitionStart?.(mode);
    startDrawLoop();
    video.pause();

    const t0 = performance.now();
    function step() {
      const t = Math.min(1, (performance.now() - t0) / dur);
      if (t >= 1) {
        landOn(targetIndex, toTime);
        return;
      }
      if (!video.seeking) {
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        video.currentTime = fromTime + (toTime - fromTime) * eased;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  video.addEventListener('loadedmetadata', () => {
    video.currentTime = tl.sections[stationIndex].time;
  });
  video.addEventListener('seeked', () => {
    drawCurrentFrame();
    opts.onStation(mode, currentStationId(), stationIndex);
  }, { once: true }); // fires once the initial seek lands, announcing the starting station
  video.addEventListener('seeked', () => drawCurrentFrame());

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
      if (reduceMotion) {
        // No animation, but still hold a brief cooldown so one scroll gesture
        // (which fires many wheel events) collapses to a single station step,
        // exactly like the animated path — never a multi-station skip.
        busy = true;
        settleAt(target, tl.sections[target].time);
        window.setTimeout(() => { busy = false; }, SETTLE_MS);
        return true;
      }
      moveTo(target);
      return true;
    },
    /** Switch sequence, keeping the same station index, no animation. */
    setMode(nextMode: string) {
      if (nextMode === mode) return;
      const nextTl = opts.timelines[nextMode];
      const keepIndex = Math.min(stationIndex, nextTl.sections.length - 1);
      stopDrawLoop();
      const oldVideo = video;
      mode = nextMode;
      tl = nextTl;
      video = createVideoEl(tl);
      video.addEventListener('loadedmetadata', () => {
        stationIndex = keepIndex;
        video.currentTime = tl.sections[stationIndex].time;
        drawCurrentFrame();
        opts.onStation(mode, currentStationId(), stationIndex);
      }, { once: true });
      video.addEventListener('seeked', () => drawCurrentFrame());
      oldVideo.pause();
      oldVideo.remove();
    },
    destroy() {
      window.removeEventListener('resize', resizeCanvas);
      stopDrawLoop();
    },
  };
}
