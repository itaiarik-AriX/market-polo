import type { ModeTimeline } from './heroTimeline';

export interface HeroStepperOptions {
  canvas: HTMLCanvasElement;
  timelines: Record<string, ModeTimeline>;
  initialMode: string;
  reduceMotion: boolean;
  /** called whenever the resting station changes (after a transition completes, or a mode switch) */
  onStation: (mode: string, stationId: string, index: number) => void;
}

const SETTLE_MS = 280; // extra cooldown after a transition before accepting new input
const MAX_TWEEN_MS = 1600; // upper bound on any single transition's duration
const MIN_TWEEN_MS = 400; // lower bound so very close stations don't feel like a hard cut
const PLAYBACK_RATE = 8; // native playback speed for forward steps — stations can be many
                          // real seconds apart in the source footage, so we play the segment
                          // fast rather than waiting out its true real-time duration

const useSmallTier =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;

/**
 * Drives a <canvas> from a hidden <video> as a set of discrete "stations": at
 * rest it shows one station's frame; a step forward auto-plays the real video
 * forward to the next station (smooth native decode, no seek jank); a step
 * back manually scrubs `currentTime` backward with the same eased eased-tween
 * used before, since browsers don't support reverse `<video>` playback.
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

  function playForwardTo(targetIndex: number) {
    const fromTime = video.currentTime;
    const toTime = tl.sections[targetIndex].time;
    busy = true;
    startDrawLoop();

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.playbackRate = 1;
      stationIndex = targetIndex;
      video.pause();
      video.currentTime = toTime;
      opts.onStation(mode, currentStationId(), stationIndex);
      window.setTimeout(() => {
        stopDrawLoop();
        drawCurrentFrame();
        busy = false;
      }, SETTLE_MS);
    }
    function onTimeUpdate() {
      if (video.currentTime >= toTime) finish();
    }
    video.addEventListener('timeupdate', onTimeUpdate);
    // Real segment duration divided by playback rate = actual wall-clock transition
    // time; safety net in case timeupdate fires too coarsely near the end.
    const realSegmentMs = Math.max(0, (toTime - fromTime) * 1000);
    const expectedMs = Math.min(MAX_TWEEN_MS, Math.max(MIN_TWEEN_MS, realSegmentMs / PLAYBACK_RATE));
    video.playbackRate = Math.max(1, realSegmentMs / expectedMs);
    window.setTimeout(finish, expectedMs + 400);

    video.play().catch(() => finish());
  }

  function tweenBackwardTo(targetIndex: number) {
    const fromTime = video.currentTime;
    const toTime = tl.sections[targetIndex].time;
    const realSegmentMs = Math.max(0, (fromTime - toTime) * 1000);
    const dur = Math.min(MAX_TWEEN_MS, Math.max(MIN_TWEEN_MS, realSegmentMs / PLAYBACK_RATE));

    if (reduceMotion) {
      settleAt(targetIndex, toTime);
      return;
    }

    busy = true;
    startDrawLoop();
    const t0 = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      video.currentTime = fromTime + (toTime - fromTime) * eased;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        stationIndex = targetIndex;
        opts.onStation(mode, currentStationId(), stationIndex);
        window.setTimeout(() => {
          stopDrawLoop();
          drawCurrentFrame();
          busy = false;
        }, SETTLE_MS);
      }
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
        settleAt(target, tl.sections[target].time);
        return true;
      }
      if (dir === 1) playForwardTo(target);
      else tweenBackwardTo(target);
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
