// Single source of truth for each mode's scroll journey. The user's own scroll
// continuously and directly drives the video's position — scrolling down plays
// it forward, scrolling up plays it backward, proportionally. Scroll distance
// is divided into alternating weighted segments:
//   HOLD   — the video pins on one station's frame while its copy is readable
//   MOTION — the video scrubs from the previous hold's time to the next
// Both weights are relative (bigger = more scroll distance = slower/longer),
// tune them freely per station while testing.

export interface Section {
  /** stable id, matches data-copy-id / data-still-id in Hero.astro */
  id: string;
  /** timestamp (seconds) into the mode's video this station rests on */
  time: number;
  /** relative scroll weight to dwell/read at this station (bigger = longer pause) */
  hold?: number;
  /** relative scroll weight for the motion INTO this station from the previous
   *  one (bigger = more scroll needed = feels slower). Ignored for the first section. */
  motion?: number;
}

export interface ModeTimeline {
  /** video path WITHOUT extension, e.g. "/video/hire" — .webm and .mp4 are both expected
   * to exist alongside each other so the browser can pick whichever it supports */
  videoBase: string;
  /** optional lighter/smaller video base for small screens; falls back to videoBase if absent */
  videoBaseSmall?: string;
  /** optional folder of high-res per-station stills, named <section id>.<ext> */
  stationsBase?: string;
  /** file extension for station stills */
  stationsExt?: string;
  sections: Section[];
}

const DEFAULT_HOLD = 1.2;
const DEFAULT_MOTION = 2.0;

export const timelines: Record<string, ModeTimeline> = {
  hire: {
    videoBase: '/video/hire',
    stationsBase: '/sequences/hire-stations/',
    stationsExt: 'webp',
    sections: [
      { id: 'welcome', time: 0, hold: 1.1 },
      // `motion` = relative scroll distance for the move INTO this station
      // (bigger = slower); `hold` = relative scroll distance spent dwelling
      // on it before continuing. Tune independently per stop.
      { id: 'exterior', time: 6.757, hold: 1.2, motion: 2.0 },
      { id: 'amenities', time: 18.936, hold: 1.2, motion: 2.6 },
      { id: 'view', time: 30.197, hold: 1.2, motion: 2.3 },
      { id: 'closing', time: 38.038, hold: 1.6, motion: 1.8 },
    ],
  },
  // Build mode uses a generated placeholder gradient video for now. TODO: give
  // it real footage once it exists, matching the hire timeline's structure.
  build: {
    videoBase: '/video/build-placeholder',
    sections: [
      { id: 'welcome', time: 0, hold: 1.1 },
      { id: 'engineering', time: 1.7, hold: 1.2, motion: 1.6 },
      { id: 'joinery', time: 2.9, hold: 1.2, motion: 1.4 },
      { id: 'finish', time: 4.2, hold: 1.2, motion: 1.6 },
      { id: 'closing', time: 4.9, hold: 1.6, motion: 1.4 },
    ],
  },
};

interface Segment {
  kind: 'hold' | 'motion';
  fromTime: number;
  toTime: number;
  start: number; // normalized progress 0-1
  end: number;
}

export interface SectionRange {
  id: string;
  /** normalized progress range where this section's copy/still should be visible */
  start: number;
  end: number;
}

export interface BuiltTimeline {
  timeAt: (progress: number) => number;
  sectionRanges: SectionRange[];
}

export function buildTimeline(tl: ModeTimeline): BuiltTimeline {
  const segments: Segment[] = [];
  let totalWeight = 0;
  for (let i = 0; i < tl.sections.length; i++) {
    const s = tl.sections[i];
    if (i > 0) totalWeight += s.motion ?? DEFAULT_MOTION;
    totalWeight += s.hold ?? DEFAULT_HOLD;
  }

  let acc = 0;
  const sectionRanges: SectionRange[] = [];
  for (let i = 0; i < tl.sections.length; i++) {
    const s = tl.sections[i];
    if (i > 0) {
      const prev = tl.sections[i - 1];
      const w = (s.motion ?? DEFAULT_MOTION) / totalWeight;
      segments.push({ kind: 'motion', fromTime: prev.time, toTime: s.time, start: acc, end: acc + w });
      acc += w;
    }
    const hw = (s.hold ?? DEFAULT_HOLD) / totalWeight;
    segments.push({ kind: 'hold', fromTime: s.time, toTime: s.time, start: acc, end: acc + hw });
    sectionRanges.push({ id: s.id, start: acc, end: acc + hw });
    acc += hw;
  }

  function timeAt(progress: number): number {
    const p = Math.max(0, Math.min(1, progress));
    for (const seg of segments) {
      if (p <= seg.end || seg === segments[segments.length - 1]) {
        if (seg.kind === 'hold') return seg.fromTime;
        const local = seg.end > seg.start ? (p - seg.start) / (seg.end - seg.start) : 0;
        return seg.fromTime + (seg.toTime - seg.fromTime) * Math.max(0, Math.min(1, local));
      }
    }
    return tl.sections[tl.sections.length - 1].time;
  }

  return { timeAt, sectionRanges };
}

/**
 * The scrub video is split into one small file per station-to-station stretch
 * (see public/video/<videoBase>-seg<N>.{mp4,webm}) rather than one large file —
 * each segment downloads in a couple of seconds on almost any connection,
 * instead of the whole thing needing 15+ seconds before later stretches are
 * reachable. This maps a GLOBAL video time (from timeAt above) to which
 * segment file backs it and the LOCAL time within that segment's own file.
 */
export function resolveSegment(tl: ModeTimeline, globalTime: number): { index: number; localTime: number } {
  const sections = tl.sections;
  for (let i = 0; i < sections.length - 1; i++) {
    const from = sections[i].time;
    const to = sections[i + 1].time;
    if (globalTime <= to || i === sections.length - 2) {
      const clamped = Math.max(from, Math.min(to, globalTime));
      return { index: i, localTime: clamped - from };
    }
  }
  return { index: 0, localTime: 0 };
}

/** Number of segment files for a timeline (one fewer than the station count). */
export function segmentCount(tl: ModeTimeline): number {
  return Math.max(1, tl.sections.length - 1);
}
