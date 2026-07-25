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

  // Common "land on a station" routine, shared by forward and backward moves.
  // Fires onStation immediately (so the sharp still begins its snappy fade-in),
  // and keeps the video's correct target frame under the crossfade — no re-seek
  // flash, no stale frame — until the still has fully covered.
  function landOn(targetIndex: number, toTime: number) {
    video.playbackRate = 1;
    video.pause();
    // Only correct time if we actually drifted; the re-seek is what can flash a
    // keyframe-approx (soft) frame right as the still fades in.
    if (Math.abs(video.currentTime - toTime) > 0.05) video.currentTime = toTime;
    stationIndex = targetIndex;
    drawCurrentFrame();
    opts.onStation(mode, currentStationId(), stationIndex);
    // Draw a couple more frames while the still (0.22s) crossfades over, then stop.
    window.setTimeout(() => {
      stopDrawLoop();
      drawCurrentFrame();
      busy = false;
    }, SETTLE_MS);
  }

  function playForwardTo(targetIndex: number) {
    const fromTime = video.currentTime;
    const toTime = tl.sections[targetIndex].time;
    // Duration is configured per-segment on the destination station.
    const desiredMs = transitionMs(tl.sections[targetIndex]);
    busy = true;
    opts.onTransitionStart?.(mode);
    startDrawLoop();

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      video.removeEventListener('timeupdate', onTimeUpdate);
      landOn(targetIndex, toTime);
    }
    function onTimeUpdate() {
      if (video.currentTime >= toTime) finish();
    }
    video.addEventListener('timeupdate', onTimeUpdate);
    // Play the real segment fast/slow enough that it lasts exactly `desiredMs`.
    const realSegmentMs = Math.max(1, (toTime - fromTime) * 1000);
    video.playbackRate = Math.max(0.25, Math.min(16, realSegmentMs / desiredMs));
    window.setTimeout(finish, desiredMs + 400); // safety net if timeupdate is coarse

    video.play().catch(() => finish());
  }

  function tweenBackwardTo(targetIndex: number) {
    const fromTime = video.currentTime;
    const toTime = tl.sections[targetIndex].time;
    // Same segment as the forward move — its duration lives on the higher station
    // (the one we're leaving), i.e. the current stationIndex.
    const dur = transitionMs(tl.sections[stationIndex]);

    if (reduceMotion) {
      settleAt(targetIndex, toTime);
      return;
    }

    busy = true;
    opts.onTransitionStart?.(mode);
    startDrawLoop();
    video.pause();

    // Browsers can't play <video> in reverse, so we scrub currentTime backward.
    // Firing a new seek every animation frame overwrites seeks the decoder hasn't
    // finished, which stutters. Instead, each frame we only issue a new seek when
    // no seek is in flight (`!video.seeking`) — pacing to the decoder's real
    // throughput (cheap now thanks to dense keyframes). The target stays
    // time-based, so the move still lasts ~`dur` regardless of decode speed.
    const t0 = performance.now();
    function step() {
      const t = Math.min(1, (performance.now() - t0) / dur);
      if (t >= 1) {
        landOn(targetIndex, toTime);
        return;
      }
      if (!video.seeking) {
        const eased = 1 - Math.pow(1 - t, 3);
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
