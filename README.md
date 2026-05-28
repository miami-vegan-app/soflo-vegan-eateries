# SoFlo Vegan Eateries 🌱

A mobile-first Progressive Web App (PWA) listing **vegan and vegan-friendly restaurants
across South Florida** — Palm Beach, Broward, Miami-Dade, and Tri-County. Data comes from
the community-maintained [South Florida Vegans](https://www.facebook.com/groups/southfloridavegans)
Google Sheet and refreshes automatically every day.

## How it works

- **Static PWA** (plain HTML/CSS/JS, no framework, no build step) in `public/`.
- **Daily data refresh:** a GitHub Action (`.github/workflows/update-data.yml`) fetches the
  Google Sheet as CSV, converts it to `public/data/restaurants.json`, and commits the result.
  That commit triggers an automatic Cloudflare Pages deploy.
- **Health checks:** a second Action (`.github/workflows/health-check.yml`) verifies the
  sheet is reachable and well-formed each day, and opens a GitHub Issue if something breaks.
- **Offline support:** a service worker caches the app shell and the latest data.

## Project layout

```
public/                  # what Cloudflare Pages serves
  index.html  styles.css  app.js
  manifest.webmanifest  sw.js
  data/restaurants.json  # generated daily
  icons/                 # generated PNG icons
scripts/
  build-data.mjs         # Google Sheet CSV -> restaurants.json
  build-icons.mjs        # assets/icon.svg -> PNG icons
assets/icon.svg          # source artwork for the icon
.github/workflows/       # daily data refresh + health check
```

## Local development

```bash
npm install            # installs sharp (only needed to regenerate icons)
npm run build:data     # refresh public/data/restaurants.json from the live sheet
npm run build:icons    # regenerate icons from assets/icon.svg
npm run serve          # serve public/ locally (http://localhost:3000)
```

Then open the local URL in your browser (or your phone on the same network) to test.

## Deploying to Cloudflare Pages (one-time)

1. Push this repo to GitHub.
2. In the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create application** → **Pages** → **Connect to Git**, and pick this repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. Deploy. Every push to the default branch — including the daily data commits from the
   GitHub Action — redeploys automatically.

> Netlify works identically: set **Publish directory** to `public` and leave the build
> command empty.

### Alternative: Cloudflare Workers (Static Assets)

This repo also includes `wrangler.jsonc`, so it can be deployed as a Worker that serves the
`public/` directory as static assets. In Cloudflare's **Workers** build flow, leave the
**build command empty** and keep the default **deploy command `npx wrangler deploy`**.
Auth is handled by the connected Cloudflare account.

## Updating the icon

Edit `assets/icon.svg`, run `npm run build:icons`, and commit the regenerated PNGs in
`public/icons/`.

## Data

- Source sheet: `https://docs.google.com/spreadsheets/d/1DQ5ys0MHw22qWXmwC_rAbLs7gQfDjFpASDii9beP9zE/edit`
- Data is prepared and managed by **David Schwartzberg**. For corrections, email
  **miamivegan2026@outlook.com**.

---

Built by [Abdullah Unal](https://www.linkedin.com/in/abdunal) using Claude AI.
