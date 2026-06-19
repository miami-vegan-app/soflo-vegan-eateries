// Re-fetches businessStatus from the Google Places API for every cached restaurant
// that has a placeId, then updates the cache in place.
//
// This is much cheaper than re-running enrich:places (Text Search) — a Place Details
// call fetching only businessStatus costs a tiny fraction of a Text Search call.
//
// Run after you suspect closures, then follow up with npm run build:data to propagate:
//   $env:GOOGLE_PLACES_API_KEY = "your-key"; npm run refresh:status
//   npm run build:data
//
// Use PLACES_MAX=N to cap the number of live API calls in one run.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, ".places-cache.json");

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const FIELD_MASK = "businessStatus";

const MAX_LOOKUPS = Number(process.env.PLACES_MAX) || Infinity;
const DELAY_MS = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus(placeId) {
  const url = `${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Places API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.businessStatus || null;
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. In PowerShell:\n" +
        '  $env:GOOGLE_PLACES_API_KEY = "your-key"; npm run refresh:status'
    );
  }
  if (!existsSync(CACHE_PATH)) {
    throw new Error("No .places-cache.json found. Run npm run enrich:places first.");
  }

  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  const entries = Object.entries(cache).filter(([, rec]) => rec.found && rec.placeId);

  console.log(`Found ${entries.length} cached entries with a placeId to check.`);

  let checked = 0;
  let changed = 0;
  const changes = [];

  for (const [key, rec] of entries) {
    if (checked >= MAX_LOOKUPS) break;

    let newStatus;
    try {
      newStatus = await fetchStatus(rec.placeId);
      checked++;
    } catch (err) {
      console.warn(`  ! ${rec.query}: ${err.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (newStatus && newStatus !== rec.businessStatus) {
      changes.push({
        name: rec.query,
        was: rec.businessStatus,
        now: newStatus,
      });
      rec.businessStatus = newStatus;
      rec.queriedAt = new Date().toISOString();
      changed++;
    }

    await sleep(DELAY_MS);
  }

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");

  console.log(`\nChecked ${checked} places, ${changed} status changes:`);
  if (changes.length === 0) {
    console.log("  (none — all statuses match what was cached)");
  } else {
    for (const c of changes) {
      console.log(`  ${c.name}: ${c.was} -> ${c.now}`);
    }
  }

  if (changed > 0) {
    console.log("\nCache updated. Run `npm run build:data` to propagate the changes.");
  }
}

main().catch((err) => {
  console.error("refresh-status failed:", err.message);
  process.exit(1);
});
