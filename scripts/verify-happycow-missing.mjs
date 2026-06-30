// Reads happycow-soflo.csv, filters to open vegan venues not in the app,
// removes chains and non-SoFlo cities, verifies each against Google Places API,
// then writes:
//   scripts/happycow-missing-verified.csv  — for the spreadsheet owner
//   scripts/happycow-missing-verified.json — for new-restaurants injection
//
// Usage: GOOGLE_PLACES_API_KEY=xxx node scripts/verify-happycow-missing.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root if present
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const CSV_IN   = resolve(__dirname, 'happycow-soflo.csv');
const CSV_OUT  = resolve(__dirname, 'happycow-missing-verified.csv');
const JSON_OUT = resolve(__dirname, 'happycow-missing-verified.json');
const CACHE    = resolve(__dirname, '.verify-places-cache.json');

const API_KEY  = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) { console.error('Set GOOGLE_PLACES_API_KEY'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Cities north of West Palm Beach — exclude from SoFlo ─────────────────────
const EXCLUDE_CITIES = new Set([
  'Palm Beach Gardens', 'Jupiter', 'Tequesta', 'North Palm Beach',
  'Lake Park', 'Jensen Beach',
]);

// ── Known chains — normalized to lowercase ───────────────────────────────────
const CHAINS = new Set([
  // National
  'chipotle','whole foods market','whole foods','sweetgreen','cava',
  "trader joe's",'trader joes','jamba','tropical smoothie cafe','tropical smoothie',
  'blaze pizza',"ben & jerry's","ben and jerry's",'carvel',
  "menchie's frozen yogurt","menchies",'first watch','smoothie king',
  "p.f. chang's",'pf changs','johnny rockets','the cheesecake factory',
  'publix','sprouts farmers market',"joe & the juice",'playa bowls',
  "sarpino's pizzeria",'pieology','i heart mac & cheese','yard house',
  'seasons 52','starbucks','sbux','panera','subway',
  // Regional chains
  'pura vida','bolay','3natives','carrot express','fresh kitchen',
  'giardino gourmet salads','raw juce','pure green','goji juicery and kitchen',
  'salt & straw','night owl cookies','sushi maki','pummarola',
  'smoothie spot',"mister o1",'vale food co','talkin tacos',"talkin' tacos",
  'taco rico','diced','rice mediterranean kitchen','rice','sano food',
  'tropical smoothie cafe','boatyard',"pei wei asian diner",'pei wei',
  "earl's kitchen + bar","earls kitchen + bar","rocco's tacos","roccos tacos",
  "the empanadas",'naked farmer','andpizza','&pizza','just salad',
  'midtown creamery','panther coffee','morelia','azucar','azucar ice cream',
  'morelia gourmet paletas','freddo','gelato go','gelato',
  'mammamia gelato italiano','rivareno gelato','davinci gelato','bianco gelato',
  'i scream gelato','aubi & ramsa','san gines beach','pure green juice bar',
  'smoothie express','powerfuel smoothie shop','green apple juice lounge',
  'juice kitchen','tropical smoothie','joe the juice',
  // Airport / hotel / non-restaurant
  'mia','fll','american airlines admirals club','holistic holiday at sea',
  'gabriela cora md','earthsave florida','nobe yoga','naturally speaking',
  // Grocery / market
  'sprouts farmers market','the fresh market','living green fresh market',
  'oriental bakery & grocery','indo american store','markys gourmet',
  "marky's gourmet",'organic grown direct','grove kosher market',
]);

function isChain(name) {
  const n = name.toLowerCase().replace(/[^a-z0-9& ]/g, '').trim();
  if (CHAINS.has(n)) return true;
  // Prefix match for "Chipotle", "Whole Foods", etc.
  for (const c of CHAINS) {
    if (n.startsWith(c) || c.startsWith(n)) return true;
  }
  return false;
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur);
  return cols;
}

function parseCsv(text) {
  const [header, ...lines] = text.split('\n').filter(Boolean);
  const headers = parseCsvLine(header);
  return lines.map(l => {
    const cols = parseCsvLine(l);
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
  });
}

function csvCell(s) {
  return `"${(s ?? '').toString().replace(/"/g, '""')}"`;
}

// ── Google Places API ─────────────────────────────────────────────────────────
const SOFLO_BOX = { minLat: 25.0, maxLat: 26.97, minLng: -80.9, maxLng: -80.0 };

async function searchPlace(name, city) {
  const query = `${name} ${city} FL`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.websiteUri',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
  });
  if (!res.ok) throw new Error(`Places API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const place = data.places?.[0];
  if (!place) return null;

  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  // Sanity check: result must be in SoFlo
  if (lat && lng) {
    if (lat < SOFLO_BOX.minLat || lat > SOFLO_BOX.maxLat ||
        lng < SOFLO_BOX.minLng || lng > SOFLO_BOX.maxLng) return null;
  }

  return {
    placeId: place.id,
    placeName: place.displayName?.text,
    address: place.formattedAddress,
    lat, lng,
    businessStatus: place.businessStatus,
    website: place.websiteUri || '',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const rows = parseCsv(readFileSync(CSV_IN, 'utf8'));

  // Filter
  const candidates = rows.filter(r => {
    if (r['In App'] !== 'No') return false;
    if (r['Status'] !== 'Open') return false;
    if (r['Veg Type'] !== 'Vegan') return false;
    if (EXCLUDE_CITIES.has(r['City (HappyCow)'])) return false;
    if (isChain(r['Name'])) return false;
    return true;
  });

  // De-duplicate by name+city
  const seen = new Set();
  const unique = candidates.filter(r => {
    const key = `${r['Name'].toLowerCase().replace(/[^a-z0-9]/g, '')}|${r['City (HappyCow)'].toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Candidates after filtering: ${unique.length} (from ${rows.length} total)`);

  // Verify via Places API
  const verified = [];
  let apiCalls = 0;
  for (const r of unique) {
    const cacheKey = `${r['Name']}|${r['City (HappyCow)']}`;
    let place = cache[cacheKey];

    if (!place) {
      process.stdout.write(`[${apiCalls + 1}/${unique.length}] ${r['Name']} (${r['City (HappyCow)']}) … `);
      try {
        place = await searchPlace(r['Name'], r['City (HappyCow)']);
        cache[cacheKey] = place || { notFound: true };
        writeFileSync(CACHE, JSON.stringify(cache, null, 2));
        apiCalls++;
        await sleep(150);
        console.log(place ? `✓ ${place.businessStatus} — ${place.address}` : '✗ not found');
      } catch (e) {
        console.error(`Error: ${e.message}`);
        place = null;
      }
    } else if (!place.notFound) {
      // cached hit
    } else {
      place = null;
    }

    // Skip if permanently closed per Google
    if (place?.businessStatus === 'CLOSED_PERMANENTLY') continue;

    verified.push({
      name: r['Name'],
      city: r['City (HappyCow)'],
      county: r['County'],
      vegType: r['Veg Type'],
      happyCowStatus: r['Status'],
      happyCowAddress: r['Address'],
      happyCowPhone: r['Phone'],
      happyCowWebsite: r['Website'],
      happyCowUrl: r['HappyCow URL'],
      reviewCount: r['Review Count'],
      // Google Places
      placeId: place?.placeId || '',
      verifiedAddress: place?.address || '',
      lat: place?.lat || '',
      lng: place?.lng || '',
      googleStatus: place?.businessStatus || '',
      googleWebsite: place?.website || '',
      googleName: place?.placeName || '',
    });
  }

  console.log(`\nVerified: ${verified.length} venues (${apiCalls} new API calls)`);

  // Write CSV
  const headers = [
    'Name','City','County','Veg Type',
    'HappyCow Status','HappyCow Address','HappyCow Phone','HappyCow Website','HappyCow URL',
    'Review Count',
    'Place ID','Verified Address','Lat','Lng','Google Status','Google Website','Google Name',
  ];
  const csvLines = [
    headers.map(csvCell).join(','),
    ...verified.map(v => [
      v.name, v.city, v.county, v.vegType,
      v.happyCowStatus, v.happyCowAddress, v.happyCowPhone, v.happyCowWebsite, v.happyCowUrl,
      v.reviewCount,
      v.placeId, v.verifiedAddress, v.lat, v.lng, v.googleStatus, v.googleWebsite, v.googleName,
    ].map(csvCell).join(',')),
  ];
  writeFileSync(CSV_OUT, csvLines.join('\n') + '\n', 'utf8');

  // Write JSON for injection into the app
  const forApp = verified
    .filter(v => v.verifiedAddress && v.lat && v.lng)
    .map(v => ({
      name: v.googleName || v.name,
      city: v.city,
      county: v.county,
      type: 'V',
      website: v.googleWebsite || v.happyCowWebsite || '',
      address: v.verifiedAddress,
      lat: v.lat,
      lng: v.lng,
      placeId: v.placeId,
      businessStatus: v.googleStatus,
      matchConfidence: 'verified',
      source: 'happycow',
      happyCowUrl: v.happyCowUrl,
    }));
  writeFileSync(JSON_OUT, JSON.stringify(forApp, null, 2) + '\n', 'utf8');

  const missing = verified.filter(v => !v.verifiedAddress).length;
  console.log(`CSV → ${CSV_OUT}`);
  console.log(`JSON → ${JSON_OUT} (${forApp.length} with coordinates, ${missing} without)`);
}

main().catch(err => { console.error(err); process.exit(1); });
