/**
 * Timing and pacing for the intro chart. Everything tunable lives here.
 *
 * The intro is never a full preloader: waiting for the whole frame sequence
 * would be 21s at 25Mbps and 53s at 10Mbps. Progress reflects what has genuinely
 * arrived, and MAX_MS gives up regardless so a slow connection is never trapped.
 */
export const INTRO = {
  /**
   * Shortest time the intro is on screen, and — because the count is paced
   * against it — how long the chart takes to draw. Raise this to linger.
   *
   * The count is deliberately limited to `elapsed / MIN_MS`: without it, a warm
   * cache finishes the whole draw in well under a second and then sits at 100%
   * doing nothing, which looks broken rather than fast.
   */
  MIN_MS: 3600,

  /**
   * Hard ceiling. If assets are still arriving the count runs to 100 anyway.
   * Must stay comfortably above MIN_MS or the pacing has no room to play out.
   */
  MAX_MS: 6000,

  /**
   * How long the FINISHED chart is held before the exit begins.
   *
   * Without this the last contour completes on the same frame that triggers the
   * exit, so the map is swept away in the act of finishing and is never seen
   * whole — which is exactly how it looked before this existed.
   *
   * This, not DRAW_COMPLETE_AT, is the real lever on "give people time to see
   * it": the count crosses the last 10% in roughly 0.1 x MIN_MS, so the hold is
   * most of the time the finished map is actually on screen.
   */
  HOLD_MS: 1400,

  /**
   * Progress at which the highest contour finishes, as a fraction. Leaving
   * headroom above it means the survey visibly completes and then the number
   * catches up, rather than both landing on the same frame.
   *
   * Note the headroom shrinks as this rises — 0.90 finishes the map LATER than
   * 0.86 did, not earlier. It is set to the figure that was asked for, and
   * HOLD_MS above carries the dwell.
   */
  DRAW_COMPLETE_AT: 0.90,

  /**
   * How much of the progress range each contour takes to draw. Windows overlap,
   * which is what makes the rings flow into one another instead of ticking on
   * one at a time.
   */
  DRAW_WINDOW: 0.14,

  /** Exit: chrome lifts, then the sheet sweeps up. Matches the CSS durations. */
  EXIT_MS: 1600,
} as const;
