// One-off dev utility: generates placeholder SVG frame sequences so the
// scroll-scrubber can be built/tested before real footage is ready.
// Run: node scripts/generate-placeholder-frames.mjs
// Delete this script (and the placeholder frames) once real sequences land.
import { mkdirSync, writeFileSync } from 'node:fs';

const THEMES = {
  hire: { count: 60, from: [10, 40, 80], to: [255, 190, 90], label: 'HIRE' },
  build: { count: 60, from: [30, 30, 32], to: [200, 140, 60], label: 'BUILD' },
};

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function frameSvg(i, total, theme) {
  const t = i / (total - 1);
  const [r1, g1, b1] = theme.from;
  const [r2, g2, b2] = theme.to;
  const r = lerp(r1, r2, t);
  const g = lerp(g1, g2, t);
  const b = lerp(b1, b2, t);
  const cx = lerp(30, 70, t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <radialGradient id="g" cx="${cx}%" cy="40%" r="75%">
      <stop offset="0%" stop-color="rgb(${r},${g},${b})"/>
      <stop offset="100%" stop-color="rgb(${Math.round(r * 0.25)},${Math.round(g * 0.25)},${Math.round(b * 0.25)})"/>
    </radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <text x="50%" y="52%" text-anchor="middle" font-family="monospace" font-size="42" fill="rgba(255,255,255,0.55)">${theme.label} — PLACEHOLDER FRAME</text>
  <text x="50%" y="60%" text-anchor="middle" font-family="monospace" font-size="28" fill="rgba(255,255,255,0.4)">${String(i + 1).padStart(4, '0')} / ${String(total).padStart(4, '0')}</text>
</svg>`;
}

for (const [mode, theme] of Object.entries(THEMES)) {
  const dir = new URL(`../public/sequences/${mode}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < theme.count; i++) {
    const name = `${String(i + 1).padStart(4, '0')}.svg`;
    writeFileSync(new URL(name, dir), frameSvg(i, theme.count, theme));
  }
  console.log(`Wrote ${theme.count} placeholder frames for "${mode}"`);
}
