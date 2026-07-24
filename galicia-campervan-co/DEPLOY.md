# Deploy — Galicia Campervan Co

This project is already connected to Cloudflare Pages via Git — **every push to the
tracked branch auto-deploys.** No manual upload step needed.

## Current setup

- Live URL: `https://galicia-f2z.pages.dev` (custom domain can be added any time —
  see below).
- Build command: `npm run build`, output directory: `dist`, root directory:
  `galicia-campervan-co` (this project lives in a subfolder of the repo).
- Cloudflare rebuilds automatically within a couple of minutes of any push. Hard
  refresh (Cmd/Ctrl+Shift+R) to bypass any cached old version.

## If you ever need to reconnect Git (new project/account)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create** → **Pages** tab → **Import an existing Git repository**.
2. Pick the repo, set **Production branch** to the branch this project tracks.
3. Build settings: framework preset **Astro**, build command `npm run build`,
   output directory `dist`, root directory `galicia-campervan-co`.
4. Save and deploy.

## Custom domain (when ready)

1. Cloudflare → **Registrar** → register the real domain — ~£10/yr
2. Cloudflare Pages → your project → **Custom Domains** → Set up a domain
3. Enter the domain — DNS auto-wires since the domain is in the same account
4. HTTPS/SSL is automatic
5. Live in ~2 minutes at the real domain

## Notes

- Everything in `public/` ships with the build, including the scrub videos and
  station stills — see the README's "Assets" section for what each is and how to
  update them.
- Cost: £0 hosting + ~£10/yr domain.
