# Deploy — Core and Soul Pilates

This site is ready to push live to Cloudflare Pages (free, fast, global CDN).

## One-time setup (5 min)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) if you don't have an account.
2. Sidebar → **Workers & Pages**.

## Each deploy (1 min)

### 1. Build the production version

```bash
cd /Users/itai/Desktop/web-business/clients/core-and-soul-pilates
npm run build
```

This creates `dist/` — the final static files.

### 2. Push to Cloudflare Pages

**First deploy (drag & drop):**

1. Cloudflare → **Workers & Pages** → **Create Application** → **Pages** tab → **Upload assets**
2. Project name: `core-and-soul-pilates` (becomes part of URL)
3. Drag the `dist/` folder into the upload zone
4. Click **Deploy site**
5. ~30 seconds later: live at `https://core-and-soul-pilates.pages.dev`

**Re-deploys:** Same flow — drag the new `dist/` into the same project.

**Better long-term: Git connect**
1. Push the folder to GitHub
2. Cloudflare Pages → Connect to Git → pick the repo
3. Build command: `npm run build`
4. Build output: `dist`
5. Every git push auto-deploys

## Custom domain (when client buys)

1. Cloudflare → **Registrar** → Register a fresh domain (e.g., `coreandsoulpilates.co.uk`) — ~£10/yr, in **your** account
2. Cloudflare Pages → your project → **Custom Domains** → Set up a domain
3. Enter the domain — auto-wires DNS since the domain is in your Cloudflare account
4. HTTPS/SSL is automatic
5. Live in 2 minutes at the real domain

## Notes

- All assets in `public/assets/` are static — they ship with the build
- The 6 Pilates photos in `public/assets/pilates-*.jpg` are from Pexels (free for commercial use, no attribution required)
- The Core and Soul logo + instructor photo are downloaded from their site for pitch purposes — if they buy, swap in their preferred photos
- Cost: £0 hosting + ~£10/yr domain. Sell at £250 → ~£240 margin
