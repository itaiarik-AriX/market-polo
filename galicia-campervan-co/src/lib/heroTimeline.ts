// Single source of truth for each mode's stations. The site steps discretely
// between these — scrolling never rests mid-video; each scroll gesture moves
// exactly one station forward or back, auto-playing the frames between them.

export interface Section {
  /** stable id, matches data-copy-id / data-still-id in Hero.astro */
  id: string;
  /** 0-based frame index (into the scrub sequence) this station rests on */
  frame: number;
}

export interface ModeTimeline {
  /** full-resolution scrub frames (desktop / large screens) */
  basePath: string;
  /** optional lighter scrub frames for small screens; falls back to basePath if absent */
  basePathSmall?: string;
  /** optional folder of high-res per-station stills, named <section id>.<ext> */
  stationsBase?: string;
  /** file extension for station stills (defaults to ext) */
  stationsExt?: string;
  frameCount: number;
  pad: number;
  ext: string;
  sections: Section[];
}

export const timelines: Record<string, ModeTimeline> = {
  hire: {
    basePath: '/sequences/hire/',
    basePathSmall: '/sequences/hire-sm/',
    stationsBase: '/sequences/hire-stations/',
    stationsExt: 'webp',
    frameCount: 457,
    pad: 4,
    ext: 'webp',
    sections: [
      { id: 'welcome', frame: 0 },
      { id: 'exterior', frame: 81 },
      { id: 'amenities', frame: 362 },
      { id: 'dream', frame: 399 },
      { id: 'closing', frame: 456 },
    ],
  },
  // Build mode still uses placeholder frames for now.
  build: {
    basePath: '/sequences/build/',
    frameCount: 60,
    pad: 4,
    ext: 'svg',
    sections: [
      { id: 'welcome', frame: 0 },
      { id: 'engineering', frame: 20 },
      { id: 'joinery', frame: 35 },
      { id: 'finish', frame: 50 },
      { id: 'closing', frame: 59 },
    ],
  },
};
