// The fleet. Single source of truth for what appears in the polaroid grid and
// in each van's gallery overlay — adding van two should be a data edit here,
// never a component edit.

export type Van = {
  id: string;
  /** Written across the bottom of the polaroid. */
  name: string;
  /** Short status line, e.g. availability. Shown on the card and in the overlay. */
  status: string;
  /** One or two sentences, overlay only. */
  blurb: string;
  /**
   * Gallery photos, in order; the first is the one on the polaroid.
   *
   * Not listed by hand — Fleet.astro reads `public/fleet/<id>/` at build time
   * and sorts by filename, so adding a photograph is dropping a file in. An
   * empty folder renders an explicit "photographs coming" frame rather than
   * borrowing the hero stills, so nothing on the page ever implies those stills
   * are this van's photos. Pass `?photos=demo` to preview with them.
   */
  photos: string[];
};

/**
 * Stand-ins for judging the polaroid treatment before the real photos arrive.
 * Reachable only via `?photos=demo`, following the same query-flag convention
 * as `?nav=a-e` and `?debug=1`. These are hero station stills, not photographs
 * of a real van.
 */
export const DEMO_PHOTOS = [
  '/sequences/hire-stations/exterior.webp',
  '/sequences/hire-stations/welcome.webp',
  '/sequences/hire-stations/amenities.webp',
  '/sequences/hire-stations/view.webp',
  '/sequences/hire-stations/closing.webp',
];

// Keyed by language then van id, matching how Hero.astro keys its copy.
type VanCopy = Pick<Van, 'name' | 'status' | 'blurb'>;

const copy: Record<string, Record<string, VanCopy>> = {
  en: {
    nomad: {
      name: 'Nomad',
      status: 'Taking bookings',
      blurb:
        "Our first, and still the one we'd take ourselves. Sleeps two, cooks properly, and gets you somewhere with a view.",
    },
  },
  es: {
    nomad: {
      name: 'Nomad',
      status: 'Aceptando reservas',
      blurb:
        'La primera, y todavía la que nos llevaríamos nosotros. Duerme a dos, cocina de verdad y te lleva a sitios con vistas.',
    },
  },
};

export const ids = ['nomad'];

/**
 * Photos are discovered from disk by Fleet.astro and handed back in here, so
 * this module stays free of `node:fs` — it is imported by the browser bundle
 * too, and a filesystem import there would break the build.
 */
export function fleetFor(lang: string, photos: Record<string, string[]> = {}): Van[] {
  const byLang = copy[lang] ?? copy.en;
  return ids.map((id) => ({ id, ...(byLang[id] ?? copy.en[id]), photos: photos[id] ?? [] }));
}

/** Every language's fleet, for rendering all variants up front like Hero does. */
export function fleetByLang(photos: Record<string, string[]> = {}): Record<string, Van[]> {
  return Object.fromEntries(Object.keys(copy).map((lang) => [lang, fleetFor(lang, photos)]));
}
