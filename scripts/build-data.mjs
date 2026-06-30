// Fetches the South Florida Vegans Google Sheet (CSV export), parses it into clean
// JSON, and writes public/data/restaurants.json.
//
// Zero external dependencies — uses Node 18+ global fetch. Run by the daily GitHub
// Action and locally via `npm run build:data`.
//
// Safety: if the fetch fails or returns implausibly few rows, the script exits
// non-zero WITHOUT overwriting the existing JSON, so a bad fetch never wipes good data.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../public/data/restaurants.json");
// Human-review corrections (location/website/rename/duplicate/closed), recorded by
// scripts/review-server.mjs and COMMITTED to git. Re-applied on every build so they
// survive the daily sheet sync. Keyed by name+city (restaurantKey).
const OVERRIDES_PATH = resolve(__dirname, "places-overrides.json");

const SHEET_ID = "1DQ5ys0MHw22qWXmwC_rAbLs7gQfDjFpASDii9beP9zE";
// The master list, grouped "By County".
const MAIN_GID = "0";
// A separate "100% Vegan" tab. It's mostly a curated subset of the main list, but a few
// fully-vegan spots are entered ONLY here, so we merge in anything not already present.
const VEGAN_GID = "119809278";
const csvUrl = (gid) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

// Minimum number of parsed restaurants we expect — guards against a partial/empty fetch.
const MIN_RESTAURANTS = 150;

// County section headers as they appear in the sheet -> clean display names.
const COUNTY_MAP = new Map([
  ["PALM BEACH COUNTY", "Palm Beach County"],
  ["BROWARD COUNTY", "Broward County"],
  ["MIAMI/DADE COUNTY", "Miami / Dade County"],
  ["TRI-COUNTY AREA", "Tri-County Area"],
]);

const TYPE_LABELS = {
  V: "Vegan",
  VF: "Vegan Friendly",
  V1: "Mostly Vegan (has honey)",
  VO: "Ask for Vegan Options",
};

const LEGEND = [
  { code: "V", label: "Vegan", description: "Fully vegan establishment." },
  { code: "VF", label: "Vegan Friendly", description: "Has items marked vegan on the menu." },
  { code: "V1", label: "Mostly Vegan", description: "Mostly vegan — has honey on the menu." },
  { code: "VO", label: "Vegan Options", description: "Ask for vegan options." },
];

// Fields owned by scripts/enrich-places.mjs (Google Places API), not the sheet. The
// daily rebuild must carry these forward from the previous restaurants.json or it would
// wipe them. Keep this list in sync with ENRICHED_FIELDS in enrich-places.mjs.
const ENRICHED_FIELDS = ["address", "lat", "lng", "businessStatus", "businessStatusAt", "placeId", "matchConfidence"];

// --- Minimal but correct CSV parser (handles quoted fields, escaped quotes, CRLF) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function cleanCell(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// "BOCA RATON" -> "Boca Raton"; leaves mixed-case input alone.
function titleCaseCity(s) {
  const c = cleanCell(s);
  if (!c || c !== c.toUpperCase()) return c;
  return c
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bFt\b/g, "Ft.");
}

// Known-bad website hostnames in the sheet -> the correct hostname. The sheet owners
// sometimes leave a typo'd URL up; we serve the working one regardless. Keyed by lowercase
// hostname (without scheme), so it applies no matter how the cell is otherwise formatted.
const WEBSITE_HOST_FIXES = new Map([
  // "mearket" typo — the typo'd domain doesn't resolve; the corrected one returns 200.
  ["ygfarmersmearket.com", "ygfarmersmarket.com"],
]);

function normalizeWebsite(raw) {
  let w = cleanCell(raw);
  if (!w) return "";
  if (!/^https?:\/\//i.test(w)) w = "https://" + w.replace(/^\/+/, "");
  try {
    // Validate; return normalized form.
    const url = new URL(w);
    const fixed = WEBSITE_HOST_FIXES.get(url.hostname.toLowerCase());
    if (fixed) url.hostname = fixed;
    return url.href;
  } catch {
    return "";
  }
}

function normalizeType(raw) {
  const t = cleanCell(raw).toUpperCase().replace(/[()]/g, "");
  if (TYPE_LABELS[t]) return t;
  // Some cells may contain extra text; pick the first known token.
  const token = t.split(/[\s/,-]+/).find((x) => TYPE_LABELS[x]);
  return token || "";
}

function parseOutdoor(raw) {
  const v = cleanCell(raw).toLowerCase();
  if (!v) return false;
  return /^(y|yes|x|true|✓|outdoor)/.test(v);
}

function isEmptyRow(row) {
  return row.every((c) => cleanCell(c) === "");
}

// Name+city identity for de-duping a restaurant across the two tabs.
function restaurantKey(r) {
  const norm = (s) => cleanCell(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${norm(r.name)}|${norm(r.city)}`;
}

// Website identity (host + path, ignoring scheme/www/query) — catches the same place
// listed under slightly different names on the two tabs (e.g. "Konata's Vegan" vs
// "Konata's Vegan Restaurant", same URL). Returns "" when there's no usable website.
function websiteKey(r) {
  if (!r.website) return "";
  try {
    const u = new URL(r.website);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return host + path;
  } catch {
    return "";
  }
}

// Parses one tab's CSV (CITY, NAME, WEBSITE, CUISINE, TYPE, OUTDOOR SEATING) into
// restaurant objects. Rows are grouped under "<COUNTY> COUNTY" section headers; pass
// `defaultCounty` for tabs whose first section has no header (the 100% Vegan tab starts
// straight into Palm Beach rows).
function parseRestaurants(csv, { defaultCounty = "" } = {}) {
  const rows = parseCsv(csv);
  const restaurants = [];
  let currentCounty = defaultCounty;

  for (const row of rows) {
    if (isEmptyRow(row)) continue;
    const first = cleanCell(row[0]).toUpperCase();

    // County section header?
    if (COUNTY_MAP.has(first) && isEmptyRow(row.slice(1))) {
      currentCounty = COUNTY_MAP.get(first);
      continue;
    }
    // Repeated column header row?
    if (first === "CITY" && cleanCell(row[1]).toUpperCase() === "NAME") continue;
    // Skip everything before the first county section (title/legend/disclaimers).
    if (!currentCounty) continue;

    const name = cleanCell(row[1]);
    if (!name) continue;

    const type = normalizeType(row[4]);
    restaurants.push({
      name,
      city: titleCaseCity(row[0]),
      county: currentCounty,
      cuisine: cleanCell(row[3]),
      type,
      typeLabel: TYPE_LABELS[type] || "",
      website: normalizeWebsite(row[2]),
      outdoorSeating: parseOutdoor(row[5]),
    });
  }

  return restaurants;
}

function fetchCsv(gid) {
  return fetch(csvUrl(gid), { redirect: "follow" }).then((res) => {
    if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
    return res.text();
  });
}

function main() {
  return fetchCsv(MAIN_GID)
    .then((csv) => {
      if (!/SOUTH FLORIDA VEGANS/i.test(csv)) {
        throw new Error("Fetched content does not look like the expected sheet.");
      }

      // Capture the "updated <date>" note from the header rows, if present.
      let sourceUpdated = "";
      const updatedMatch = csv.match(/updated\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
      if (updatedMatch) sourceUpdated = updatedMatch[1].replace(/\s+/g, " ").trim();

      const restaurants = parseRestaurants(csv);

      if (restaurants.length < MIN_RESTAURANTS) {
        throw new Error(
          `Only parsed ${restaurants.length} restaurants (min ${MIN_RESTAURANTS}) — aborting to protect existing data.`
        );
      }

      // Merge in fully-vegan spots that live only on the "100% Vegan" tab. This is
      // supplementary — if it fails, keep the good main-list data rather than aborting.
      return fetchCsv(VEGAN_GID)
        .then((veganCsv) => {
          const veganOnly = parseRestaurants(veganCsv, { defaultCounty: "Palm Beach County" });
          const haveNames = new Set(restaurants.map(restaurantKey));
          const haveSites = new Set(restaurants.map(websiteKey).filter(Boolean));
          let added = 0;
          for (const r of veganOnly) {
            const site = websiteKey(r);
            if (haveNames.has(restaurantKey(r)) || (site && haveSites.has(site))) continue;
            haveNames.add(restaurantKey(r));
            if (site) haveSites.add(site);
            restaurants.push(r);
            added++;
          }
          console.log(
            `100% Vegan tab: ${veganOnly.length} entries, merged ${added} not already on the main list.`
          );
        })
        .catch((err) => {
          console.warn(
            `Warning: could not merge the 100% Vegan tab (${err.message}). Continuing with the main list only.`
          );
        })
        .then(() => finalize(restaurants, sourceUpdated));
    });
}

// Layers the human-review corrections and Google business-status on top of the freshly
// parsed sheet rows. Runs AFTER the enrichment carry-forward, so it overrides the cached
// address/website where a human made a call. Mutates `restaurants` in place.
//
// Outputs (consumed by public/app.js):
//   r.hidden / r.hiddenReason   — drop from the list (permanently closed or duplicate)
//   r.closedTemporarily / r.closedSince — show a "temporarily closed (as of …)" tag
//   r.formerName                — show a subtle "formerly …" note after a rename
function applyOverridesAndStatus(restaurants) {
  let overrides = {};
  if (existsSync(OVERRIDES_PATH)) {
    try { overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8")); }
    catch { console.warn("Warning: places-overrides.json is unreadable — skipping overrides."); }
  }

  let renamed = 0;
  for (const r of restaurants) {
    // 1) Closure straight from Google Places (status was carried forward onto the row).
    if (r.businessStatus === "CLOSED_PERMANENTLY") {
      r.hidden = true;
      r.hiddenReason = "closed_permanently";
    } else if (r.businessStatus === "CLOSED_TEMPORARILY") {
      r.closedTemporarily = true;
      r.closedSince = r.businessStatusAt || "";
    }

    // Match on the ORIGINAL sheet name+city — compute the key before any rename below.
    const o = overrides[restaurantKey(r)];
    if (!o) continue;

    if (o.location) {
      const L = o.location;
      if (L.decision === "approve") {
        if (L.address) r.address = L.address;
        if (typeof L.lat === "number") r.lat = L.lat;
        if (typeof L.lng === "number") r.lng = L.lng;
        r.matchConfidence = "verified"; // a human confirmed the pin
      } else if (L.decision === "reject") {
        // No trustworthy location — drop the (possibly wrong) pin so it can't feed
        // distance sorting or a map marker. The card still shows unless also hidden.
        r.address = "";
        r.lat = null;
        r.lng = null;
        r.matchConfidence = "rejected";
      }
    }

    if (o.website) {
      if (o.website.decision === "ok") {
        delete r.websiteStatus;                 // human confirmed it works — restore the link
        if (o.website.url) r.website = o.website.url;
      } else if (o.website.decision === "down") {
        r.websiteStatus = "down";
      }
    }

    // 2) Manual closure for places Google still lists as open (food trucks, wrong-match pins).
    if (o.closed === "permanent") {
      r.hidden = true;
      r.hiddenReason = "closed_permanently";
    } else if (o.closed === "temporary") {
      r.closedTemporarily = true;
      if (!r.closedSince) r.closedSince = o.reviewedAt || "";
    }

    // 3) Duplicate row — hide the loser, keep the canonical one it points at.
    if (o.duplicateOf) {
      r.hidden = true;
      r.hiddenReason = "duplicate";
    }

    // 4) Rename to a clean display name; keep the former name for a "formerly …" note.
    if (o.rename && o.rename !== r.name) {
      r.formerName = r.name;
      r.name = o.rename;
      renamed++;
    }

    // 5) Generic field overrides — set any scalar field the sheet got wrong.
    if (o.set && typeof o.set === "object") {
      for (const [key, val] of Object.entries(o.set)) {
        r[key] = val;
      }
    }
  }

  const hidden = restaurants.filter((r) => r.hidden).length;
  const temp = restaurants.filter((r) => r.closedTemporarily && !r.hidden).length;
  console.log(
    `Overrides + status applied: ${hidden} hidden (closed/dupe), ` +
      `${temp} temporarily-closed (tagged), ${renamed} renamed.`
  );
}

function finalize(restaurants, sourceUpdated) {
  const counties = [...new Set(restaurants.map((r) => r.county))];
  const now = new Date().toISOString();

  // Carry forward Places-API enrichment (address/lat/lng/status) from the previous
  // build — those fields come from enrich-places.mjs, not the sheet, so a fresh sheet
  // parse must not erase them. Matched by name+city via restaurantKey().
  if (existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      const byKey = new Map((prev.restaurants || []).map((r) => [restaurantKey(r), r]));
      for (const r of restaurants) {
        const old = byKey.get(restaurantKey(r));
        if (!old) continue;
        for (const f of ENRICHED_FIELDS) {
          if (old[f] !== undefined) r[f] = old[f];
        }
        // Carry forward the website down-flag (set by scripts/check-websites.mjs --write),
        // but ONLY while the URL is unchanged. If the sheet now has a different website,
        // the old verdict no longer applies — drop it so the new URL gets re-checked fresh.
        if (old.websiteStatus === "down" && old.website === r.website) {
          r.websiteStatus = old.websiteStatus;
          if (old.websiteCheckedAt !== undefined) r.websiteCheckedAt = old.websiteCheckedAt;
        }
      }
    } catch {
      /* no usable previous file — nothing to carry forward */
    }
  }

  // Inject new restaurants from scripts/new-restaurants.json (added by verify-happycow-missing.mjs).
  // Entries are merged in by restaurantKey so re-running never creates duplicates.
  const NEW_PATH = resolve(__dirname, "new-restaurants.json");
  if (existsSync(NEW_PATH)) {
    try {
      const newEntries = JSON.parse(readFileSync(NEW_PATH, "utf8"));
      const existingKeys = new Set(restaurants.map(restaurantKey));
      let added = 0;
      for (const r of newEntries) {
        if (!r.name || !r.city) continue;
        const k = restaurantKey(r);
        if (existingKeys.has(k)) continue;
        // Fill in any fields the sheet normally provides but new entries may omit.
        const entry = {
          name: r.name,
          city: r.city,
          county: r.county || "",
          cuisine: r.cuisine || "",
          type: r.type || "V",
          typeLabel: TYPE_LABELS[r.type || "V"] || "",
          website: r.website || "",
          outdoorSeating: r.outdoorSeating ?? false,
          // Enrichment fields (pre-filled from Places API, carried forward on future builds).
          address: r.address || "",
          lat: r.lat || null,
          lng: r.lng || null,
          placeId: r.placeId || "",
          businessStatus: r.businessStatus || "",
          matchConfidence: r.matchConfidence || "verified",
        };
        restaurants.push(entry);
        existingKeys.add(k);
        added++;
      }
      if (added) console.log(`Injected ${added} new restaurants from ${NEW_PATH}`);
    } catch (e) {
      console.warn(`Warning: could not load ${NEW_PATH}: ${e.message}`);
    }
  }

  // Layer human-review corrections + Google business-status on top (after carry-forward,
  // so a human verdict overrides the cached enrichment).
  applyOverridesAndStatus(restaurants);

  // Everything except the timestamps — used to detect whether the list actually changed.
  const data = {
    sourceUpdated,
    source: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    count: restaurants.length,
    legend: LEGEND,
    counties,
    restaurants,
  };

  // `checkedAt` always advances — we fetch daily and want to show users the last fetch.
  // `updatedAt` only advances when the underlying list actually changed, so it reflects
  // when the data last differed (carried forward from the previous file when unchanged).
  let updatedAt = now;
  if (existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      const { updatedAt: _u, checkedAt: _c, ...prevData } = prev;
      if (JSON.stringify(prevData) === JSON.stringify(data)) {
        updatedAt = prev.updatedAt || now;
      }
    } catch {
      /* fall through and overwrite a corrupt file */
    }
  }

  const out = { updatedAt, checkedAt: now, ...data };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `Wrote ${restaurants.length} restaurants across ${counties.length} counties ` +
      `(updatedAt ${updatedAt}, checkedAt ${now}) -> ${OUT_PATH}`
  );
}

main().catch((err) => {
  console.error("build-data failed:", err.message);
  process.exit(1);
});
