// Single source of truth for each mode's scroll journey.
//
// The scroll distance is divided into alternating segments:
//   HOLD   — the sequence freezes on one frame while a section's copy is shown
//   MOTION — the sequence scrubs from the previous hold's frame to the next
//
// Both the canvas scrubber (scroll -> frame) and the Hero copy (scroll -> which
// text is visible) are derived from the same `sections` list, so they can never
// drift out of sync. Frame numbers are 0-based indices into the sequence
// (file 0001.webp = index 0). Nothing here is time-based: the user's scroll
// position IS the position in the sequence, always, with no animation of its
// own — so scrolling never fights the user.

export interface Section {
  /** stable id, matches data-copy-id / data-still-id in Hero.astro */
  id: string;
  /** 0-based frame index to freeze on during this section's hold */
  frame: number;
  /** relative scroll span to pause on this frame (bigger = longer read time) */
  hold: number;
  /** relative scroll span of the motion leading INTO this hold (ignored for the first section) */
  motion: number;
  /**
   * Optional ambient loop played while resting on this station, so the scene is
   * alive (waves rolling, grass moving) rather than a frozen frame. Path without
   * extension — `.mp4` and `.webm` are both expected, e.g. '/loops/welcome'.
   *
   * The clip MUST open on this section's `frame`, which is what the canvas holds
   * on: the crossfade then happens between the loop and an identical still image
   * while nothing else is moving, which is what makes the handover invisible.
   * Generate it from the matching plate in docs/station-plates/.
   */
  loop?: string;
}

export interface ModeTimeline {
  /** full-resolution frames (desktop / large screens) */
  basePath: string;
  /** optional lighter frames for small screens; falls back to basePath if absent */
  basePathSmall?: string;
  /**
   * Optional 9:16 recut for phones held upright. Cover-fitting the wide frames
   * to a portrait screen shows only ~26% of their width, so this is a genuinely
   * different framing rather than just a smaller file — see
   * scripts/make-portrait-tier.py for the per-station pan.
   */
  basePathPortrait?: string;
  /** optional folder of high-res per-station stills, named <section id>.<ext> */
  stationsBase?: string;
  /** portrait-cropped stills, matching basePathPortrait's framing */
  stationsBasePortrait?: string;
  /** file extension for station stills (defaults to ext) */
  stationsExt?: string;
  frameCount: number;
  pad: number;
  ext: string;
  sections: Section[];
}

// Station frame indices are the source timestamps on the 12fps grid the frames
// were extracted at (frame = round(seconds * 12)) — welcome 0.000s, exterior
// 6.757s, amenities 18.936s, view 30.197s, closing 38.038s.
export const timelines: Record<string, ModeTimeline> = {
  hire: {
    basePath: '/sequences/hire/',
    basePathSmall: '/sequences/hire-sm/',
    basePathPortrait: '/sequences/hire-portrait/',
    stationsBase: '/sequences/hire-stations/',
    stationsBasePortrait: '/sequences/hire-stations-portrait/',
    stationsExt: 'webp',
    frameCount: 457,
    pad: 4,
    ext: 'webp',
    sections: [
      // `hold` = how much scroll distance is spent paused here reading the copy;
      // `motion` = how much scroll distance the move INTO this station takes
      // (bigger = slower/more cinematic). Both are relative weights — tune freely.
      { id: 'welcome', frame: 0, hold: 1.1, motion: 0, loop: '/loops/welcome' },
      { id: 'exterior', frame: 81, hold: 1.2, motion: 2.4 },
      { id: 'amenities', frame: 227, hold: 1.2, motion: 3.0 },
      { id: 'view', frame: 362, hold: 1.2, motion: 2.8 },
      { id: 'closing', frame: 456, hold: 1.6, motion: 2.0, loop: '/loops/closing' },
    ],
  },
  // Build mode still uses placeholder frames for now; evenly-spaced holds.
  build: {
    basePath: '/sequences/build/',
    frameCount: 60,
    pad: 4,
    ext: 'svg',
    sections: [
      { id: 'welcome', frame: 0, hold: 1.1, motion: 0 },
      { id: 'engineering', frame: 20, hold: 1.2, motion: 2.4 },
      { id: 'joinery', frame: 35, hold: 1.2, motion: 1.8 },
      { id: 'finish', frame: 50, hold: 1.2, motion: 2.4 },
      { id: 'closing', frame: 59, hold: 1.6, motion: 1.6 },
    ],
  },
};

interface Segment {
  kind: 'hold' | 'motion';
  fromFrame: number;
  toFrame: number;
  start: number; // normalized progress 0-1
  end: number;
}

export interface SectionRange {
  id: string;
  /** normalized progress range where this section's copy should be visible */
  start: number;
  end: number;
}

export interface BuiltTimeline {
  frameAt: (progress: number) => number;
  sectionRanges: SectionRange[];
  frameCount: number;
  /** the frame each station rests on — used to prioritise loading those first */
  stationFrames: number[];
}

export function buildTimeline(tl: ModeTimeline): BuiltTimeline {
  const segments: Segment[] = [];
  let totalWeight = 0;
  for (let i = 0; i < tl.sections.length; i++) {
    const s = tl.sections[i];
    if (i > 0) totalWeight += s.motion;
    totalWeight += s.hold;
  }

  let acc = 0;
  const sectionRanges: SectionRange[] = [];
  for (let i = 0; i < tl.sections.length; i++) {
    const s = tl.sections[i];
    if (i > 0) {
      const prev = tl.sections[i - 1];
      const w = s.motion / totalWeight;
      segments.push({ kind: 'motion', fromFrame: prev.frame, toFrame: s.frame, start: acc, end: acc + w });
      acc += w;
    }
    const hw = s.hold / totalWeight;
    segments.push({ kind: 'hold', fromFrame: s.frame, toFrame: s.frame, start: acc, end: acc + hw });
    sectionRanges.push({ id: s.id, start: acc, end: acc + hw });
    acc += hw;
  }

  function frameAt(progress: number): number {
    const p = Math.max(0, Math.min(1, progress));
    for (const seg of segments) {
      if (p <= seg.end || seg === segments[segments.length - 1]) {
        if (seg.kind === 'hold') return seg.fromFrame;
        const local = seg.end > seg.start ? (p - seg.start) / (seg.end - seg.start) : 0;
        const f = seg.fromFrame + (seg.toFrame - seg.fromFrame) * Math.max(0, Math.min(1, local));
        return Math.round(f);
      }
    }
    return tl.sections[tl.sections.length - 1].frame;
  }

  return {
    frameAt,
    sectionRanges,
    frameCount: tl.frameCount,
    stationFrames: tl.sections.map((s) => s.frame),
  };
}
