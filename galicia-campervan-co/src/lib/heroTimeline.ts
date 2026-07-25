// Single source of truth for each mode's stations. The site steps discretely
// between these — one scroll gesture (or swipe, or arrow key) moves exactly
// one station forward or back, auto-playing the footage between them; it
// never rests mid-video. Scroll footage is split into one small file per
// station-to-station stretch (see public/video/<videoBase>-seg<N>.{mp4,webm})
// rather than one large file spanning the whole thing — segment `i` covers
// the stretch between station `i` and station `i+1`.

export interface Section {
  /** stable id, matches data-copy-id / data-still-id in Hero.astro */
  id: string;
  /** timestamp (seconds) into the ORIGINAL full-length footage this station
   *  rests on — kept for reference/documentation; seeking itself is driven by
   *  each segment file's own natural duration, not this value. */
  time: number;
  /**
   * How long (seconds) the animated move takes when travelling INTO this
   * station from the previous one. The first station has no incoming move,
   * so its value is ignored. Tune these freely to pace each transition; the
   * backward step reuses the same value for the same segment. Falls back to
   * DEFAULT_TRANSITION_S if omitted.
   */
  transition?: number;
}

export interface ModeTimeline {
  /** video path prefix, e.g. "/video/hire" — segment files are named
   * "<videoBase>-seg<N>.mp4" / ".webm" for N in [0, sections.length - 2] */
  videoBase: string;
  /** optional lighter/smaller video base for small screens; falls back to videoBase if absent */
  videoBaseSmall?: string;
  /** optional folder of high-res per-station stills, named <section id>.<ext> */
  stationsBase?: string;
  /** file extension for station stills */
  stationsExt?: string;
  sections: Section[];
}

export const timelines: Record<string, ModeTimeline> = {
  hire: {
    videoBase: '/video/hire',
    stationsBase: '/sequences/hire-stations/',
    stationsExt: 'webp',
    sections: [
      { id: 'welcome', time: 0 },
      // `transition` = seconds the animated move into this station takes. Tweak
      // these to pace each segment independently (welcome has no incoming move).
      { id: 'exterior', time: 6.757, transition: 2.4 },
      { id: 'amenities', time: 18.936, transition: 3.2 },
      { id: 'view', time: 30.197, transition: 2.8 },
      { id: 'closing', time: 38.038, transition: 2.2 },
    ],
  },
  // Build mode uses a generated placeholder gradient video for now. TODO: give
  // it real footage once it exists, matching the hire timeline's structure.
  build: {
    videoBase: '/video/build-placeholder',
    sections: [
      { id: 'welcome', time: 0 },
      { id: 'engineering', time: 1.7, transition: 1.2 },
      { id: 'joinery', time: 2.9, transition: 1.2 },
      { id: 'finish', time: 4.2, transition: 1.2 },
      { id: 'closing', time: 4.9, transition: 1.0 },
    ],
  },
};

/** Number of segment files for a timeline (one fewer than the station count). */
export function segmentCount(tl: ModeTimeline): number {
  return Math.max(1, tl.sections.length - 1);
}
