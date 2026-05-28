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

const SHEET_ID = "1DQ5ys0MHw22qWXmwC_rAbLs7gQfDjFpASDii9beP9zE";
const GID = "0";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

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

function normalizeWebsite(raw) {
  let w = cleanCell(raw);
  if (!w) return "";
  if (!/^https?:\/\//i.test(w)) w = "https://" + w.replace(/^\/+/, "");
  try {
    // Validate; return normalized form.
    return new URL(w).href;
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

function main() {
  return fetch(CSV_URL, { redirect: "follow" })
    .then((res) => {
      if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
      return res.text();
    })
    .then((csv) => {
      if (!/SOUTH FLORIDA VEGANS/i.test(csv)) {
        throw new Error("Fetched content does not look like the expected sheet.");
      }

      const rows = parseCsv(csv);

      // Capture the "updated <date>" note from the header rows, if present.
      let sourceUpdated = "";
      const updatedMatch = csv.match(/updated\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
      if (updatedMatch) sourceUpdated = updatedMatch[1].replace(/\s+/g, " ").trim();

      const restaurants = [];
      let currentCounty = "";

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

      if (restaurants.length < MIN_RESTAURANTS) {
        throw new Error(
          `Only parsed ${restaurants.length} restaurants (min ${MIN_RESTAURANTS}) — aborting to protect existing data.`
        );
      }

      const counties = [...new Set(restaurants.map((r) => r.county))];

      const out = {
        updatedAt: new Date().toISOString(),
        sourceUpdated,
        source: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
        count: restaurants.length,
        legend: LEGEND,
        counties,
        restaurants,
      };

      mkdirSync(dirname(OUT_PATH), { recursive: true });

      // Only write if content (ignoring the timestamp) actually changed, so the daily
      // Action produces a clean no-op commit when the sheet is unchanged.
      const nextSansTime = JSON.stringify({ ...out, updatedAt: "" });
      if (existsSync(OUT_PATH)) {
        try {
          const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
          const prevSansTime = JSON.stringify({ ...prev, updatedAt: "" });
          if (prevSansTime === nextSansTime) {
            console.log(`No data changes (${restaurants.length} restaurants). Skipping write.`);
            return;
          }
        } catch {
          /* fall through and overwrite a corrupt file */
        }
      }

      writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
      console.log(
        `Wrote ${restaurants.length} restaurants across ${counties.length} counties -> ${OUT_PATH}`
      );
    });
}

main().catch((err) => {
  console.error("build-data failed:", err.message);
  process.exit(1);
});
