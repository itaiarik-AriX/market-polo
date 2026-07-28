# Nomad — gallery photographs

Drop this van's photographs in this folder, then list them in
`src/lib/fleet.ts` under `photos.nomad`.

## Naming

Any names work, but numbering keeps the order obvious:

```
01-exterior.webp
02-interior.webp
03-kitchen.webp
```

## Wiring them up

`src/lib/fleet.ts`:

```ts
const photos: Record<string, string[]> = {
  nomad: [
    '/fleet/nomad/01-exterior.webp',
    '/fleet/nomad/02-interior.webp',
    '/fleet/nomad/03-kitchen.webp',
  ],
};
```

Paths start at `/fleet/...` — `public/` is the web root, so it is not part of
the URL. **The first photo in the list is the one on the polaroid**; the rest
follow it in the gallery, in this order.

Once the list is non-empty the "Photographs coming" placeholder disappears on
its own, and the gallery arrows and counter appear automatically.

## Format and size

- **WebP** preferred, JPEG fine. Roughly **2000px on the long edge** — the
  gallery never shows more than about 1100px wide, so beyond that is wasted
  download.
- Keep each file **under 25 MiB**; Cloudflare Pages rejects the whole deploy
  above that, which has bitten this project before.
- Any aspect ratio works. The polaroid crops to a square from the centre and
  the gallery frame is 3:2, so keep the van roughly centred and avoid anything
  important in the far corners.

## Don't apply a filter first

The vintage treatment is applied in CSS at display time
(`sepia/saturate/contrast` plus grain, in `src/components/Fleet.astro`). Upload
clean, unfiltered photographs — otherwise the effect is applied twice. Changing
the look later is then a CSS tweak rather than re-exporting every file.
