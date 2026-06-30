// Crawls HappyCow for all vegan/vegan-friendly venues across South Florida cities,
// then cross-references with our restaurants.json and outputs a CSV.
//
// Usage:  node scripts/crawl-happycow.mjs
// Output: scripts/happycow-soflo.csv  (new results appended; skip already-done URLs)
//         scripts/.happycow-cache.json (raw per-venue data, survives restarts)
//
// Be polite: ~1.5 s delay between venue page requests; headless Chromium.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH    = resolve(__dirname, '../public/data/restaurants.json');
const CACHE_PATH   = resolve(__dirname, '.happycow-cache.json');
const CSV_PATH     = resolve(__dirname, 'happycow-soflo.csv');
const BASE_URL     = 'https://www.happycow.net';
const DELAY_MS     = 1500; // base delay; actual = DELAY_MS + random 0-1000ms

// ── South Florida cities ──────────────────────────────────────────────────────
const CITIES = [
  // Miami / Dade County
  { slug: 'miami',              county: 'Miami / Dade County' },
  { slug: 'miami_beach',        county: 'Miami / Dade County' },
  { slug: 'south_miami',        county: 'Miami / Dade County' },
  { slug: 'miami_gardens',      county: 'Miami / Dade County' },
  { slug: 'north_miami_beach',  county: 'Miami / Dade County' },
  { slug: 'north_miami',        county: 'Miami / Dade County' },
  { slug: 'coral_gables',       county: 'Miami / Dade County' },
  { slug: 'aventura',           county: 'Miami / Dade County' },
  { slug: 'doral',              county: 'Miami / Dade County' },
  { slug: 'homestead',          county: 'Miami / Dade County' },
  { slug: 'hialeah',            county: 'Miami / Dade County' },
  { slug: 'miami_lakes',        county: 'Miami / Dade County' },
  { slug: 'miami_springs',      county: 'Miami / Dade County' },
  { slug: 'key_biscayne',       county: 'Miami / Dade County' },
  { slug: 'cutler_bay',         county: 'Miami / Dade County' },
  { slug: 'palmetto_bay',       county: 'Miami / Dade County' },
  { slug: 'pinecrest',          county: 'Miami / Dade County' },
  { slug: 'florida_city',       county: 'Miami / Dade County' },
  // Broward County
  { slug: 'fort_lauderdale',    county: 'Broward County' },
  { slug: 'hollywood',          county: 'Broward County' },
  { slug: 'pembroke_pines',     county: 'Broward County' },
  { slug: 'coral_springs',      county: 'Broward County' },
  { slug: 'pompano_beach',      county: 'Broward County' },
  { slug: 'deerfield_beach',    county: 'Broward County' },
  { slug: 'hallandale_beach',   county: 'Broward County' },
  { slug: 'davie',              county: 'Broward County' },
  { slug: 'weston',             county: 'Broward County' },
  { slug: 'miramar',            county: 'Broward County' },
  { slug: 'lauderhill',         county: 'Broward County' },
  { slug: 'sunrise',            county: 'Broward County' },
  { slug: 'tamarac',            county: 'Broward County' },
  { slug: 'north_lauderdale',   county: 'Broward County' },
  { slug: 'lauderdale-by-the-sea', county: 'Broward County' },
  { slug: 'wilton_manors',      county: 'Broward County' },
  { slug: 'plantation',         county: 'Broward County' },
  { slug: 'cooper_city',        county: 'Broward County' },
  { slug: 'dania_beach',        county: 'Broward County' },
  { slug: 'west_park',          county: 'Broward County' },
  { slug: 'oakland_park',       county: 'Broward County' },
  { slug: 'margate',            county: 'Broward County' },
  { slug: 'coconut_creek',      county: 'Broward County' },
  { slug: 'parkland',           county: 'Broward County' },
  { slug: 'lighthouse_point',   county: 'Broward County' },
  // Palm Beach County
  { slug: 'boca_raton',         county: 'Palm Beach County' },
  { slug: 'west_palm_beach',    county: 'Palm Beach County' },
  { slug: 'delray_beach',       county: 'Palm Beach County' },
  { slug: 'boynton_beach',      county: 'Palm Beach County' },
  { slug: 'palm_beach_gardens', county: 'Palm Beach County' },
  { slug: 'jupiter',            county: 'Palm Beach County' },
  { slug: 'lake_worth',         county: 'Palm Beach County' },
  { slug: 'wellington',         county: 'Palm Beach County' },
  { slug: 'royal_palm_beach',   county: 'Palm Beach County' },
  { slug: 'riviera_beach',      county: 'Palm Beach County' },
  { slug: 'tequesta',           county: 'Palm Beach County' },
  { slug: 'north_palm_beach',   county: 'Palm Beach County' },
  { slug: 'jensen_beach',       county: 'Palm Beach County' },
  { slug: 'palm_beach',         county: 'Palm Beach County' },
  { slug: 'lake_park',          county: 'Palm Beach County' },
  { slug: 'greenacres',         county: 'Palm Beach County' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => sleep(DELAY_MS + Math.floor(Math.random() * 1000));

function normKey(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function csvCell(s) {
  const str = (s ?? '').toString().replace(/"/g, '""');
  return `"${str}"`;
}

// Extract restaurant name from page title: "Name - City Florida Restaurant - HappyCow"
function nameFromTitle(title) {
  return title.replace(/\s*-\s*.+Florida.+HappyCow.*$/i, '').trim();
}

// Slugify a city slug back to display name
function cityFromSlug(slug) {
  return slug.replace(/_/g, ' ').replace(/-/g, '-').replace(/\b\w/g, c => c.toUpperCase());
}

// Load existing app restaurants for matching
function loadAppRestaurants() {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  return (data.restaurants || []).filter(r => !r.hidden).map(r => ({
    name: r.name,
    city: r.city,
    key: normKey(r.name),
  }));
}

function matchesApp(name, appList) {
  const key = normKey(name);
  const match = appList.find(r => {
    // Exact normalised match
    if (r.key === key) return true;
    // One contains the other (handles "Arun's" vs "Aruns Indian Kitchen")
    if (key.length >= 5 && (r.key.includes(key) || key.includes(r.key))) return true;
    return false;
  });
  return match ? match.name : '';
}

// ── City page scraper ─────────────────────────────────────────────────────────
async function collectCityUrls(page, citySlug) {
  const urls = new Set();
  let pageNum = 1;

  while (true) {
    const url = `${BASE_URL}/north_america/usa/florida/${citySlug}/${pageNum > 1 ? `?page=${pageNum}` : ''}`;
    console.log(`  → Fetching city page: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      console.log(`    (timeout on ${url} — skipping)`);
      break;
    }

    // Dismiss cookie banner once
    try { await page.click('button:has-text("Accept")', { timeout: 2000 }); } catch {}

    await sleep(2000);

    // Scroll to trigger lazy loading
    const prevCount = urls.size;
    for (let i = 0; i < 25; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(300);
    }
    await sleep(1500);

    const pageUrls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/reviews/"]'))
        .map(a => a.href)
        .filter(h => h && !h.includes('#') && !/\/(write|edit|report|flag|photos|menu)\/?$/.test(h))
    );

    let added = 0;
    for (const u of pageUrls) {
      if (!urls.has(u)) { urls.add(u); added++; }
    }

    console.log(`    Page ${pageNum}: +${added} new URLs (total ${urls.size})`);

    // Stop if this page added nothing new (end of results or city has no next page)
    if (added === 0) break;
    pageNum++;
    await jitter();
  }

  return [...urls];
}

// ── Venue page scraper ────────────────────────────────────────────────────────
async function scrapeVenue(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
  } catch {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 8000 });
    } catch {
      return null;
    }
  }
  await sleep(1200);

  return await page.evaluate((venueUrl) => {
    const get = (sel) => document.querySelector(sel)?.innerText?.trim() || '';
    const getMeta = (prop) => document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.content || '';

    const title   = document.title;
    const bodyTxt = document.body.innerText;

    // Name from title
    const name = title.replace(/\s*-\s*.+Florida.*HappyCow.*$/i, '').trim();

    // Address & phone (schema.org microdata)
    const address = get('[itemprop="address"]');
    const phone   = get('[itemprop="telephone"]');

    // Veg type — look for standalone badge text
    let vegType = '';
    if (/\bVegan\b/.test(bodyTxt) && !/Vegan.?Friendly/i.test(bodyTxt.split('\n').slice(0, 30).join('\n'))) {
      vegType = 'Vegan';
    }
    if (/Vegan.?Friendly/i.test(bodyTxt.split('\n').slice(0, 30).join('\n'))) vegType = 'Vegan-Friendly';
    if (/\bVegetarian\b/i.test(bodyTxt.split('\n').slice(0, 10).join('\n')) && !vegType) vegType = 'Vegetarian';

    // More reliable: look for the type in the first ~500 chars of body text
    const topText = bodyTxt.slice(0, 600);
    if (/Vegan-Friendly/i.test(topText)) vegType = 'Vegan-Friendly';
    else if (/\bVegan\b/.test(topText)) vegType = 'Vegan';
    else if (/Vegetarian/i.test(topText)) vegType = 'Vegetarian';

    // Open/closed status
    let status = 'Unknown';
    if (/Permanently Closed/i.test(bodyTxt)) status = 'Permanently Closed';
    else if (/\bClosed\b/.test(topText)) status = 'Closed';
    else if (/\bOpen\b/.test(topText)) status = 'Open';

    // Website — first external link that isn't happycow/google/facebook sharer/uber/doordash/insta
    const website = Array.from(document.querySelectorAll('a[href^="http"]'))
      .map(a => a.href)
      .find(h =>
        !h.includes('happycow') &&
        !h.includes('google.com/maps') &&
        !h.includes('facebook.com/sharer') &&
        !h.includes('twitter.com/intent') &&
        !h.includes('ubertrk') &&
        !h.includes('doordash.7zd') &&
        !h.includes('instagram.com') &&
        !h.includes('facebook.com/')
      ) || '';

    // Short description from meta
    const description = getMeta('og:description') || getMeta('description');

    // Rating — look for a number in parentheses near the top
    const ratingMatch = bodyTxt.match(/\((\d+)\)/);
    const reviewCount = ratingMatch ? ratingMatch[1] : '';

    return { name, address, phone, vegType, status, website, description, reviewCount, url: venueUrl };
  }, url);
}

// ── Main ──────────────────────────────────────────────────────────────────────
// ── CSV writer (can be called at any time from cache) ────────────────────────
function writeCSV(cache, appList) {
  const CSV_HEADER = [
    'Name', 'City (HappyCow)', 'County', 'Veg Type', 'Status',
    'Address', 'Phone', 'Website', 'HappyCow URL',
    'Review Count', 'Description', 'In App', 'App Name',
  ].map(csvCell).join(',');

  const rows = [CSV_HEADER];
  for (const [url, v] of Object.entries(cache.venues || {})) {
    if (!v.name) continue;
    const cityDisplay = v.citySlug ? cityFromSlug(v.citySlug) : '';
    const appName = matchesApp(v.name, appList);
    rows.push([
      v.name, cityDisplay, v.county || '', v.vegType || '',
      v.status || '', v.address || '', v.phone || '',
      v.website || '', url, v.reviewCount || '', v.description || '',
      appName ? 'Yes' : 'No', appName,
    ].map(csvCell).join(','));
  }

  writeFileSync(CSV_PATH, rows.join('\n') + '\n', 'utf8');
  const missing = rows.slice(1).filter(r => r.includes('"No",')).length;
  console.log(`CSV written → ${CSV_PATH}`);
  console.log(`  Total: ${rows.length - 1}  |  Not in app: ${missing}  |  In app: ${rows.length - 1 - missing}`);
}

async function main() {
  const args = process.argv.slice(2);
  const phase1Only = args.includes('--phase1');
  const phase2Only = args.includes('--phase2');
  const csvOnly    = args.includes('--csv');

  const appList = loadAppRestaurants();
  console.log(`Loaded ${appList.length} app restaurants for matching.\n`);

  const cache = existsSync(CACHE_PATH)
    ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    : { cityUrls: {}, venues: {} };

  // ── CSV only ──────────────────────────────────────────────────────────────
  if (csvOnly) {
    writeCSV(cache, appList);
    return;
  }

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ];
  let uaIndex = 0;

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  async function freshPage() {
    const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
    uaIndex++;
    const c = await browser.newContext({
      userAgent: ua,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await c.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return c.newPage();
  }

  let page = await freshPage();

  // ── Phase 1: collect all venue URLs per city ──────────────────────────────
  if (!phase2Only) {
    for (const { slug, county } of CITIES) {
      if (cache.cityUrls[slug]) {
        const cached   = cache.cityUrls[slug];
        const urlCount = Array.isArray(cached) ? cached.length : (cached.urls || []).length;
        if (urlCount > 0) {
          console.log(`[${slug}] Skipping (cached: ${urlCount} URLs)`);
          continue;
        }
        console.log(`[${slug}] Re-crawling (got 0 last time)…`);
        await sleep(3000);
      }
      console.log(`\n[${slug}] Collecting venue URLs…`);
      const urls = await collectCityUrls(page, slug);
      cache.cityUrls[slug] = { county, urls };
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      console.log(`[${slug}] Saved ${urls.length} URLs.`);
      await jitter();
    }

    // Summary after Phase 1
    let totalUrls = 0;
    const zeroSlugs = [];
    for (const { slug } of CITIES) {
      const e = cache.cityUrls[slug];
      const n = e ? (Array.isArray(e) ? e.length : (e.urls || []).length) : 0;
      totalUrls += n;
      if (n === 0) zeroSlugs.push(slug);
    }
    console.log(`\nPhase 1 done. Total URLs: ${totalUrls}`);
    if (zeroSlugs.length) console.log(`Still 0-URL: ${zeroSlugs.join(', ')}`);
    if (phase1Only) { await browser.close(); return; }
  }

  // ── Phase 2: scrape each venue page ──────────────────────────────────────
  const allUrls  = new Set();
  const urlToCity = {};
  for (const { slug, county } of CITIES) {
    const entry = cache.cityUrls[slug];
    if (!entry) continue;
    const urls = Array.isArray(entry) ? entry : (entry.urls || []);
    for (const url of urls) {
      allUrls.add(url);
      if (!urlToCity[url]) urlToCity[url] = { citySlug: slug, county };
    }
  }

  const remaining = [...allUrls].filter(u => !cache.venues[u]);
  const total     = allUrls.size;
  const doneCount = total - remaining.length;
  console.log(`\nPhase 2: ${remaining.length} venues to scrape (${doneCount}/${total} already cached)\n`);

  const RATE_LIMIT_NAMES = new Set([
    'Unusual Traffic from your computer',
    'Member Login - HappyCow',
    'Find Vegan & Vegetarian Restaurants Near Me - HappyCow',
  ]);
  const isRateLimited = (name) => !name || RATE_LIMIT_NAMES.has(name) || name.startsWith('Update ');

  let consecutiveBlocked = 0;
  let i = doneCount;
  for (const url of remaining) {
    i++;
    process.stdout.write(`[${i}/${total}] ${url.split('/reviews/')[1]} … `);
    const data = await scrapeVenue(page, url);

    if (data && !isRateLimited(data.name)) {
      cache.venues[url] = { ...data, ...urlToCity[url] };
      process.stdout.write(`✓ ${data.name} (${data.status})\n`);
      consecutiveBlocked = 0;
    } else if (data && isRateLimited(data.name)) {
      // Rate limited — don't cache; rotate browser session after 3 in a row
      consecutiveBlocked++;
      process.stdout.write(`⚠ rate-limited (${consecutiveBlocked} in a row)\n`);
      if (consecutiveBlocked >= 3) {
        console.log('  Rotating browser session + sleeping 30s…');
        await page.context().close().catch(() => {});
        await sleep(30000);
        page = await freshPage();
        consecutiveBlocked = 0;
      } else {
        await sleep(15000);
      }
      continue;
    } else {
      cache.venues[url] = { name: '', status: 'Error', url, ...urlToCity[url] };
      process.stdout.write(`✗ (failed)\n`);
      consecutiveBlocked = 0;
    }

    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    await jitter();
  }

  await browser.close();
  console.log('\nPhase 2 complete. Writing CSV…');
  writeCSV(cache, appList);
}

main().catch(err => { console.error(err); process.exit(1); });
