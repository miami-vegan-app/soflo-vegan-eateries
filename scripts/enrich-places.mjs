// Enriches public/data/restaurants.json with street address, lat/lng, and
// business status by querying the Google Places API (Text Search, New).
//
// Why this exists: the source sheet has only a city per restaurant — no street
// address and no coordinates. "Near me" distance sorting needs lat/lng, and a
// real address is nicer to display than a bare city. One Text Search per
// restaurant ("<name> <city> FL") returns lat/lng, formattedAddress AND
// businessStatus in a single call.
//
// Cost & safety:
//   - Run LOCALLY, on demand (NOT in the daily sync) — addresses rarely change.
//     Set GOOGLE_PLACES_API_KEY in the env, then: npm run enrich:places
//   - Results are cached in scripts/.places-cache.json (gitignored), keyed by
//     name+city, so re-runs only spend an API call on rows we haven't seen.
//   - Wrong-match is the real danger: a confidently-wrong address is worse than
//     none. Every result is gated on (a) name-token overlap and (b) the returned
//     coordinates falling inside a South Florida bounding box. Anything that
//     fails either check is still stored, but tagged matchConfidence:"approximate"
//     so the UI can suppress it rather than trust it.
//
// Zero external dependencies — Node 18+ global fetch.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../public/data/restaurants.json");
const CACHE_PATH = resolve(__dirname, ".places-cache.json");

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus";

// Cap lookups in a single run — handy for a cheap first test (PLACES_MAX=5).
const MAX_LOOKUPS = Number(process.env.PLACES_MAX) || Infinity;
// Be polite to the API between live calls.
const DELAY_MS = 120;

// Fields this script owns on each restaurant. Kept in this order so build-data's
// carry-forward writes them identically and the "did the list change?" diff stays stable.
export const ENRICHED_FIELDS = [
  "address",
  "lat",
  "lng",
  "businessStatus",
  "placeId",
  "matchConfidence",
];

// South Florida bounding box (Palm Beach + Broward + Miami-Dade, generous on the
// west edge for Belle Glade / Weston). A match outside this box is almost
// certainly a same-named place in another city, so it can't be "high" confidence.
const SOFLO_BBOX = { minLat: 24.9, maxLat: 27.3, minLng: -81.2, maxLng: -79.9 };

// Generic words that shouldn't drive a name match.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "co", "llc", "inc",
  "restaurant", "restaurante", "cafe", "café", "kitchen", "bar", "grill",
  "grille", "eatery", "bistro", "house", "shop", "spot",
]);

// Same name+city identity build-data uses, so the cache and the daily
// carry-forward line up exactly.
function restaurantKey(r) {
  const norm = (s) => (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${norm(r.name)}|${norm(r.city)}`;
}

function nameTokens(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Fraction of the restaurant's distinctive name tokens that appear in the
// Places result name. 1.0 = every meaningful word matched.
function nameOverlap(ours, theirs) {
  const a = nameTokens(ours);
  const b = nameTokens(theirs);
  if (a.length === 0) return 0;
  // A token counts as matched on an exact hit OR a prefix relationship (≥4 chars),
  // so "Aruns" matches "Arun's" and plurals/possessives don't tank the score.
  const matches = (t) =>
    b.some((u) => u === t || (t.length >= 4 && u.length >= 4 && (u.startsWith(t) || t.startsWith(u))));
  return a.filter(matches).length / a.length;
}

function inSoFlo(lat, lng) {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    lat >= SOFLO_BBOX.minLat &&
    lat <= SOFLO_BBOX.maxLat &&
    lng >= SOFLO_BBOX.minLng &&
    lng <= SOFLO_BBOX.maxLng
  );
}

// Miami-Dade neighborhoods/areas the sheet names but Google reports under the parent
// municipality. Without these, correct matches (e.g. a Brickell spot whose Places
// address says "Miami") would be wrongly flagged as a city mismatch. Keyed by normalized
// sheet city -> the municipality string we'll also accept in the address.
const CITY_ALIASES = new Map([
  ["brickell", "miami"],
  ["kendall", "miami"],
  ["coconut grove", "miami"],
  ["south miami", "miami"],
  ["doral", "miami"],
  ["aventura", "miami"],
]);

// The real location gate: does the sheet's city (or its known parent municipality)
// actually appear in the Places address? The SoFlo bbox alone is too coarse — a
// same-named place in another SoFlo city (e.g. a Boca listing matched to North Miami
// Beach) would pass it. Padded with spaces so we match whole words, and "Ft." is
// normalized to "fort" to line up with Google's spelling.
function cityMatches(city, address) {
  const norm = (s) =>
    ` ${(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bft\b/g, "fort").trim()} `;
  const c = norm(city);
  if (c.trim() === "") return false;
  const addr = norm(address);
  if (addr.includes(c)) return true;
  const alias = CITY_ALIASES.get(c.trim());
  return alias ? addr.includes(` ${alias} `) : false;
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    console.warn("Warning: .places-cache.json is unreadable — starting a fresh cache.");
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One Text Search call. Returns the first place, or null when there's no result.
async function searchPlace(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: "US",
      languageCode: "en",
      maxResultCount: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Places API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.places && json.places.length ? json.places[0] : null;
}

// Turns a raw Places result into the cache record we store. We cache only the raw API
// fields — NOT the confidence verdict — so the gate can be tuned and re-applied later
// without re-spending API calls. `place` may be null (no result).
function toRecord(query, place) {
  const base = { queriedAt: new Date().toISOString(), query };
  if (!place) return { ...base, found: false };

  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  return {
    ...base,
    found: true,
    placeId: place.id || "",
    displayName: place.displayName?.text || "",
    address: place.formattedAddress || "",
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
    businessStatus: place.businessStatus || "",
  };
}

// Derives the confidence verdict from a (cached) raw result. "high" only when the name
// matches AND the city matches AND the point is in SoFlo — anything else is flagged
// "approximate" for the UI to suppress, since a confidently-wrong address is worse than none.
// Half the distinctive name tokens must line up. Kept moderately lenient because a "high"
// verdict ALSO requires the city and region to match, so a wrong place in the right city
// can't sneak through on a half-name alone.
const NAME_OVERLAP_MIN = 0.5;

function confidenceFor(r, rec) {
  const nameOk = nameOverlap(r.name, rec.displayName) >= NAME_OVERLAP_MIN;
  const cityOk = cityMatches(r.city, rec.address);
  const region = inSoFlo(rec.lat, rec.lng);
  return nameOk && cityOk && region ? "high" : "approximate";
}

// Copies the record's enriched fields onto a restaurant object (in ENRICHED_FIELDS
// order). Returns the confidence verdict, or null if there was nothing to apply.
function applyRecord(r, rec) {
  if (!rec || !rec.found) return null;
  const confidence = confidenceFor(r, rec);
  r.address = rec.address;
  r.lat = rec.lat;
  r.lng = rec.lng;
  r.businessStatus = rec.businessStatus;
  r.placeId = rec.placeId;
  r.matchConfidence = confidence;
  return confidence;
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. In PowerShell:\n" +
        '  $env:GOOGLE_PLACES_API_KEY = "your-key"; npm run enrich:places'
    );
  }
  if (!existsSync(DATA_PATH)) {
    throw new Error(`No ${DATA_PATH}. Run "npm run build:data" first.`);
  }

  const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const restaurants = data.restaurants || [];
  if (restaurants.length === 0) throw new Error("restaurants.json has no restaurants.");

  const cache = loadCache();

  let lookups = 0;
  let fromCache = 0;
  let high = 0;
  let approx = 0;
  let notFound = 0;

  for (const r of restaurants) {
    const key = restaurantKey(r);
    let rec = cache[key];

    if (!rec) {
      if (lookups >= MAX_LOOKUPS) continue; // hit the per-run cap; leave for next run
      const query = `${r.name} ${r.city} FL`;
      try {
        const place = await searchPlace(query);
        rec = toRecord(query, place);
        cache[key] = rec;
        saveCache(cache); // persist after every call so a crash never loses paid lookups
        lookups++;
        await sleep(DELAY_MS);
      } catch (err) {
        // A single failed lookup shouldn't kill the run — leave the row for next time.
        console.warn(`  ! ${r.name} (${r.city}): ${err.message}`);
        continue;
      }
    } else {
      fromCache++;
    }

    if (!rec.found) {
      notFound++;
      continue;
    }
    const confidence = applyRecord(r, rec);
    if (confidence === "high") high++;
    else approx++;
  }

  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");

  console.log(
    `Enriched ${restaurants.length} restaurants: ${high} high-confidence, ` +
      `${approx} approximate (flagged), ${notFound} no match.`
  );
  console.log(
    `API calls this run: ${lookups} new, ${fromCache} served from cache` +
      (lookups >= MAX_LOOKUPS ? ` (stopped at PLACES_MAX=${MAX_LOOKUPS})` : "") +
      "."
  );
}

main().catch((err) => {
  console.error("enrich-places failed:", err.message);
  process.exit(1);
});
