# Deploy — Galicia Campervan Co

This site is ready to push live to Cloudflare Pages (free, fast, global CDN) — the
same flow as the other sites.

## One-time setup (5 min)

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Sidebar → **Workers & Pages**.

## Each deploy (1 min)

### 1. Build the production version

```bash
cd galicia-campervan-co
npm run build
```

This creates `dist/` — the final static files.

### 2. Push to Cloudflare Pages

**First deploy (drag & drop):**

1. Cloudflare → **Workers & Pages** → **Create Application** → **Pages** tab → **Upload assets**
2. Project name: `galicia-campervan-co` (becomes part of the URL)
3. Drag the `dist/` folder into the upload zone
4. Click **Deploy site**
5. ~30 seconds later: live at `https://galicia-campervan-co.pages.dev`

**Re-deploys:** Same flow — drag the new `dist/` into the same project.

**Better long-term: Git connect**

1. Push the folder to GitHub
2. Cloudflare Pages → Connect to Git → pick the repo
3. Build command: `npm run build`
4. Build output: `dist`
5. Every git push auto-deploys

## Custom domain (when ready)

1. Cloudflare → **Registrar** → register the real domain — ~£10/yr
2. Cloudflare Pages → your project → **Custom Domains** → Set up a domain
3. Enter the domain — DNS auto-wires since the domain is in the same account
4. HTTPS/SSL is automatic
5. Live in ~2 minutes at the real domain

## Notes

- Everything in `public/` ships with the build, including the frame sequences —
  once real footage is in, keep sequences compressed (see README) so first load
  stays fast.
- Current frames are placeholders; the site is safe to deploy as a preview but
  swap in real sequences before showing customers.
- Cost: £0 hosting + ~£10/yr domain.
