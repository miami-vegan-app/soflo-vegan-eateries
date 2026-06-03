// Local review tool for the human-verification pile.
//
// Some restaurants couldn't be auto-verified: their Google Places match failed our
// confidence gate (matchConfidence != "high"), or their website returned a clean 404
// (websiteStatus: "down"). Rather than trust or discard those blindly, this serves a
// small browser UI to review each one by hand — approve the location, fix the address /
// lat / lng, confirm or clear a dead website — and records the verdicts.
//
// Decisions are written to scripts/places-overrides.json (COMMITTED to git), so they:
//   - survive the daily sheet sync and any future re-enrichment, and
//   - are re-applied on every build by build-data.mjs (wired separately).
//
// Every decision auto-saves the instant you click — same "persist after every action"
// safety as the Places cache, so a crash or closed tab never loses your review work.
//
// Zero external dependencies — Node 18+ http + fs. Run: npm run review
//   then open http://localhost:5174

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../public/data/restaurants.json");
const CACHE_PATH = resolve(__dirname, ".places-cache.json");
const OVERRIDES_PATH = resolve(__dirname, "places-overrides.json");
const PORT = Number(process.env.PORT) || 5174;

// --- Identity + confidence helpers (mirrors enrich-places.mjs so the displayed
//     "why it failed" reasons match exactly how the gate actually judged it) -------
function restaurantKey(r) {
  const norm = (s) => (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${norm(r.name)}|${norm(r.city)}`;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "co", "llc", "inc",
  "restaurant", "restaurante", "cafe", "café", "kitchen", "bar", "grill",
  "grille", "eatery", "bistro", "house", "shop", "spot",
]);

function nameTokens(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function nameOverlap(ours, theirs) {
  const a = nameTokens(ours);
  const b = nameTokens(theirs);
  if (a.length === 0) return 0;
  const matches = (t) =>
    b.some((u) => u === t || (t.length >= 4 && u.length >= 4 && (u.startsWith(t) || t.startsWith(u))));
  return a.filter(matches).length / a.length;
}

const SOFLO_BBOX = { minLat: 24.9, maxLat: 27.3, minLng: -81.2, maxLng: -79.9 };
function inSoFlo(lat, lng) {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    lat >= SOFLO_BBOX.minLat && lat <= SOFLO_BBOX.maxLat &&
    lng >= SOFLO_BBOX.minLng && lng <= SOFLO_BBOX.maxLng
  );
}

const CITY_ALIASES = new Map([
  ["brickell", "miami"], ["kendall", "miami"], ["coconut grove", "miami"],
  ["south miami", "miami"], ["doral", "miami"], ["aventura", "miami"],
]);

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

// --- Data loading -----------------------------------------------------------------
const readJson = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
};

function loadOverrides() {
  return readJson(OVERRIDES_PATH, {});
}

function saveOverrides(o) {
  writeFileSync(OVERRIDES_PATH, JSON.stringify(o, null, 2) + "\n");
}

// Build the review list: every restaurant with a location OR website issue, joined
// with its raw Google result (from the cache) and any decision already recorded.
function buildItems() {
  const data = readJson(DATA_PATH, { restaurants: [] });
  const cache = readJson(CACHE_PATH, {});
  const overrides = loadOverrides();
  const items = [];

  for (const r of data.restaurants) {
    const hasLocationIssue = r.matchConfidence !== "high";
    const hasWebsiteIssue = r.websiteStatus === "down";
    if (!hasLocationIssue && !hasWebsiteIssue) continue;

    const key = restaurantKey(r);
    const rec = cache[key];
    let google = null;
    let reasons = null;
    if (rec && rec.found) {
      google = {
        query: rec.query || "",
        displayName: rec.displayName || "",
        address: rec.address || "",
        lat: rec.lat ?? null,
        lng: rec.lng ?? null,
        businessStatus: rec.businessStatus || "",
      };
      reasons = {
        nameOverlap: Math.round(nameOverlap(r.name, rec.displayName) * 100),
        nameOk: nameOverlap(r.name, rec.displayName) >= 0.5,
        cityOk: cityMatches(r.city, rec.address),
        inRegion: inSoFlo(rec.lat, rec.lng),
      };
    }

    items.push({
      key,
      name: r.name,
      city: r.city,
      county: r.county,
      cuisine: r.cuisine,
      type: r.type,
      typeLabel: r.typeLabel,
      hasLocationIssue,
      hasWebsiteIssue,
      matchConfidence: r.matchConfidence || (rec && !rec.found ? "no-match" : "none"),
      google,
      reasons,
      website: { url: r.website || "", checkedAt: r.websiteCheckedAt || "" },
      decision: overrides[key] || null,
    });
  }
  return { items };
}

// --- HTTP -------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = PAGE;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && req.url === "/api/items") {
      sendJson(res, 200, buildItems());
      return;
    }

    if (req.method === "POST" && req.url === "/api/decision") {
      const body = await readBody(req);
      const { key } = body;
      if (!key) { sendJson(res, 400, { error: "missing key" }); return; }
      const overrides = loadOverrides();
      const prev = overrides[key] || {};
      const next = {
        ...prev,
        name: body.name ?? prev.name,
        city: body.city ?? prev.city,
        reviewedAt: new Date().toISOString(),
      };
      if (body.location) next.location = body.location;   // {decision, address?, lat?, lng?, note?}
      if (body.website) next.website = body.website;      // {decision, url?, note?}
      overrides[key] = next;
      saveOverrides(overrides);
      sendJson(res, 200, { ok: true, decision: next });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const { items } = buildItems();
  console.log(`\n  Review tool running at  http://localhost:${PORT}`);
  console.log(`  ${items.length} restaurants to review (location + website issues).`);
  console.log(`  Decisions auto-save to ${OVERRIDES_PATH}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});

// --- The page (inline single-file app) --------------------------------------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SoFlo Vegan — Review</title>
<style>
  :root { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1a1a1a; background: #f4f5f7; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e3e3e6;
    padding: .8rem 1.2rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  header h1 { font-size: 1.05rem; margin: 0; }
  .progress { font-size: .9rem; color: #444; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; width: 180px; background: #e3e3e6; border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #1b873f; width: 0; transition: width .2s; }
  .filters { display: flex; gap: .4rem; margin-left: auto; flex-wrap: wrap; }
  .filters button { border: 1px solid #d0d0d4; background: #fff; border-radius: 999px;
    padding: .3rem .8rem; font-size: .82rem; cursor: pointer; color: #333; }
  .filters button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  main { max-width: 880px; margin: 1.2rem auto; padding: 0 1rem 4rem; display: flex; flex-direction: column; gap: 1rem; }
  .card { background: #fff; border: 1px solid #e3e3e6; border-left: 5px solid #d0d0d4; border-radius: 12px;
    padding: 1rem 1.1rem; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card.done { border-left-color: #1b873f; }
  .card-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  .card-head h2 { font-size: 1.1rem; margin: 0; }
  .sub { color: #666; font-size: .88rem; }
  .chips { display: flex; gap: .4rem; margin-left: auto; flex-wrap: wrap; }
  .chip { font-size: .72rem; font-weight: 700; padding: .15rem .55rem; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; }
  .chip.approx { background: #fdf0d5; color: #8a5a00; }
  .chip.nomatch { background: #fde2e1; color: #a11; }
  .chip.web { background: #e7e0fb; color: #553c9a; }
  .chip.ok { background: #d7f0dd; color: #1b6e33; }
  .panel { margin-top: .9rem; padding: .8rem; background: #fafafb; border: 1px solid #eee; border-radius: 9px; }
  .panel h3 { margin: 0 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .kv { display: grid; grid-template-columns: 7.5rem 1fr; gap: .25rem .6rem; font-size: .9rem; margin-bottom: .6rem; }
  .kv dt { color: #888; } .kv dd { margin: 0; word-break: break-word; }
  .reasons { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .reason { font-size: .78rem; padding: .15rem .5rem; border-radius: 6px; }
  .reason.pass { background: #d7f0dd; color: #1b6e33; }
  .reason.fail { background: #fde2e1; color: #a11; }
  .fields { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .6rem; }
  .field { display: flex; flex-direction: column; gap: .15rem; flex: 1 1 8rem; }
  .field.wide { flex-basis: 100%; }
  .field label { font-size: .72rem; color: #888; text-transform: uppercase; letter-spacing: .03em; }
  .field input, .field textarea { font: inherit; font-size: .9rem; padding: .4rem .5rem; border: 1px solid #d0d0d4; border-radius: 6px; }
  .actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  .actions button { font: inherit; font-size: .88rem; font-weight: 600; padding: .45rem .9rem; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
  .btn-approve { background: #1b873f; color: #fff; }
  .btn-reject { background: #fff; color: #a11; border-color: #e3b3b1; }
  .btn-ok { background: #1565c0; color: #fff; }
  .btn-down { background: #fff; color: #8a5a00; border-color: #e6c48a; }
  button.chosen { outline: 3px solid rgba(0,0,0,.12); }
  .verdict { font-size: .85rem; font-weight: 600; margin-left: .3rem; }
  a { color: #1565c0; }
  .links { font-size: .85rem; margin-bottom: .6rem; display: flex; gap: 1rem; flex-wrap: wrap; }
  .saved { color: #1b873f; font-size: .82rem; opacity: 0; transition: opacity .15s; }
  .saved.show { opacity: 1; }
  .empty { text-align: center; color: #999; padding: 3rem; }
</style>
</head>
<body>
<header>
  <h1>🌱 SoFlo Vegan — Review</h1>
  <div class="bar"><i id="barfill"></i></div>
  <span class="progress" id="progress">0 / 0 reviewed</span>
  <div class="filters" id="filters">
    <button data-f="all" class="active">All</button>
    <button data-f="todo">Unreviewed</button>
    <button data-f="location">Location</button>
    <button data-f="website">Website</button>
  </div>
</header>
<main id="list"><p class="empty">Loading…</p></main>

<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
let ITEMS = [];
let filter = "all";

function mapsCoord(lat, lng) { return "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lng; }
function mapsSearch(q) { return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q); }

function locDone(it) { return !it.hasLocationIssue || (it.decision && it.decision.location && it.decision.location.decision); }
function webDone(it) { return !it.hasWebsiteIssue || (it.decision && it.decision.website && it.decision.website.decision); }
function itemDone(it) { return locDone(it) && webDone(it); }

function refreshProgress() {
  const done = ITEMS.filter(itemDone).length;
  document.getElementById("progress").textContent = done + " / " + ITEMS.length + " reviewed";
  document.getElementById("barfill").style.width = ITEMS.length ? (100 * done / ITEMS.length) + "%" : "0";
}

function visible(it) {
  if (filter === "all") return true;
  if (filter === "todo") return !itemDone(it);
  if (filter === "location") return it.hasLocationIssue;
  if (filter === "website") return it.hasWebsiteIssue;
  return true;
}

async function save(it, patch) {
  const r = await fetch("/api/decision", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: it.key, name: it.name, city: it.city, ...patch }),
  });
  const j = await r.json();
  if (j.ok) it.decision = j.decision;
  return j.ok;
}

function flashSaved(card) {
  const s = card.querySelector(".saved");
  if (!s) return;
  s.classList.add("show");
  setTimeout(() => s.classList.remove("show"), 1200);
}

function render() {
  const list = document.getElementById("list");
  const shown = ITEMS.filter(visible);
  if (!shown.length) { list.innerHTML = '<p class="empty">Nothing here. 🎉</p>'; refreshProgress(); return; }
  list.innerHTML = "";
  for (const it of shown) list.appendChild(card(it));
  refreshProgress();
}

function card(it) {
  const el = document.createElement("section");
  el.className = "card" + (itemDone(it) ? " done" : "");
  const dec = it.decision || {};

  const chips = [];
  if (it.hasLocationIssue) {
    chips.push(it.matchConfidence === "no-match"
      ? '<span class="chip nomatch">no map match</span>'
      : '<span class="chip approx">approx location</span>');
  }
  if (it.hasWebsiteIssue) chips.push('<span class="chip web">website 404</span>');

  let html = '<div class="card-head">'
    + '<h2>' + esc(it.name) + '</h2>'
    + '<span class="sub">' + esc(it.city || "(no city)") + ' · ' + esc(it.county) + ' · ' + esc(it.cuisine || "—")
    + (it.typeLabel ? ' · ' + esc(it.typeLabel) : "") + '</span>'
    + '<span class="chips">' + chips.join("") + '</span></div>';

  // --- Location panel ---
  if (it.hasLocationIssue) {
    const g = it.google;
    const ld = dec.location || {};
    html += '<div class="panel" data-loc>';
    html += '<h3>Location — does Google have the right place?</h3>';
    if (g) {
      const rs = it.reasons || {};
      html += '<dl class="kv">'
        + '<dt>Google name</dt><dd>' + esc(g.displayName) + '</dd>'
        + '<dt>Address</dt><dd>' + esc(g.address || "—") + '</dd>'
        + '<dt>Coords</dt><dd>' + (g.lat != null ? g.lat + ", " + g.lng : "—") + '</dd>'
        + '<dt>Status</dt><dd>' + esc(g.businessStatus || "—") + '</dd>'
        + '</dl>';
      html += '<div class="reasons">'
        + '<span class="reason ' + (rs.nameOk ? "pass" : "fail") + '">name ' + rs.nameOverlap + '%</span>'
        + '<span class="reason ' + (rs.cityOk ? "pass" : "fail") + '">city ' + (rs.cityOk ? "✓" : "✗") + '</span>'
        + '<span class="reason ' + (rs.inRegion ? "pass" : "fail") + '">in SoFlo ' + (rs.inRegion ? "✓" : "✗") + '</span>'
        + '</div>';
      html += '<div class="links">'
        + (g.lat != null ? '<a href="' + mapsCoord(g.lat, g.lng) + '" target="_blank" rel="noopener">📍 Open Google\\'s pin</a>' : "")
        + '<a href="' + mapsSearch(it.name + " " + it.city + " FL") + '" target="_blank" rel="noopener">🔎 Search Maps for this place</a>'
        + '</div>';
    } else {
      html += '<p class="sub">No Google match at all. Add the correct address & coords below if you have them, or reject.</p>';
      html += '<div class="links"><a href="' + mapsSearch(it.name + " " + it.city + " FL") + '" target="_blank" rel="noopener">🔎 Search Maps for this place</a></div>';
    }
    // editable fields, prefilled with the override (if any) else Google's values
    const pAddr = ld.address ?? (g ? g.address : "");
    const pLat = ld.lat ?? (g ? g.lat : "");
    const pLng = ld.lng ?? (g ? g.lng : "");
    html += '<div class="fields">'
      + '<div class="field wide"><label>Correct address</label><input data-f="address" value="' + esc(pAddr) + '"></div>'
      + '<div class="field"><label>Lat</label><input data-f="lat" value="' + esc(pLat ?? "") + '"></div>'
      + '<div class="field"><label>Lng</label><input data-f="lng" value="' + esc(pLng ?? "") + '"></div>'
      + '<div class="field wide"><label>Note (optional)</label><input data-f="note" value="' + esc(ld.note || "") + '"></div>'
      + '</div>';
    html += '<div class="actions">'
      + '<button class="btn-approve' + (ld.decision === "approve" ? " chosen" : "") + '" data-act="loc-approve">✅ Approve location</button>'
      + '<button class="btn-reject' + (ld.decision === "reject" ? " chosen" : "") + '" data-act="loc-reject">❌ No precise location</button>'
      + '<span class="verdict">' + (ld.decision ? "→ " + ld.decision : "") + '</span>'
      + '</div></div>';
  }

  // --- Website panel ---
  if (it.hasWebsiteIssue) {
    const wd = dec.website || {};
    html += '<div class="panel" data-web>';
    html += '<h3>Website — flagged dead (404). Is it actually working?</h3>';
    html += '<div class="links"><a href="' + esc(it.website.url) + '" target="_blank" rel="noopener">' + esc(it.website.url) + '</a>'
      + (it.website.checkedAt ? '<span class="sub">checked ' + esc(it.website.checkedAt) + '</span>' : "") + '</div>';
    html += '<div class="fields">'
      + '<div class="field wide"><label>Corrected URL (if different)</label><input data-f="weburl" value="' + esc(wd.url ?? it.website.url) + '"></div>'
      + '<div class="field wide"><label>Note (optional)</label><input data-f="webnote" value="' + esc(wd.note || "") + '"></div>'
      + '</div>';
    html += '<div class="actions">'
      + '<button class="btn-ok' + (wd.decision === "ok" ? " chosen" : "") + '" data-act="web-ok">🔗 Works — show it</button>'
      + '<button class="btn-down' + (wd.decision === "down" ? " chosen" : "") + '" data-act="web-down">🚫 Confirm dead — keep hidden</button>'
      + '<span class="verdict">' + (wd.decision ? "→ " + (wd.decision === "ok" ? "show" : "hidden") : "") + '</span>'
      + '</div></div>';
  }

  html += '<span class="saved">✓ saved</span>';
  el.innerHTML = html;
  wire(el, it);
  return el;
}

function val(el, name) { const i = el.querySelector('[data-f="' + name + '"]'); return i ? i.value.trim() : ""; }
function numOrNull(s) { const n = parseFloat(s); return Number.isFinite(n) ? n : null; }

function wire(el, it) {
  el.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      let patch = null;
      if (act.startsWith("loc-")) {
        patch = { location: {
          decision: act === "loc-approve" ? "approve" : "reject",
          address: val(el, "address"), lat: numOrNull(val(el, "lat")), lng: numOrNull(val(el, "lng")),
          note: val(el, "note"),
        } };
      } else if (act.startsWith("web-")) {
        patch = { website: {
          decision: act === "web-ok" ? "ok" : "down",
          url: val(el, "weburl"), note: val(el, "webnote"),
        } };
      }
      if (!patch) return;
      const ok = await save(it, patch);
      if (ok) {
        flashSaved(el);
        // update chosen-state + done border without a full re-render (keeps scroll position)
        el.classList.toggle("done", itemDone(it));
        const group = act.startsWith("loc-") ? "loc-" : "web-";
        el.querySelectorAll('button[data-act^="' + group + '"]').forEach((b) => b.classList.toggle("chosen", b === btn));
        const verdict = btn.closest(".actions").querySelector(".verdict");
        if (verdict) {
          if (group === "loc-") verdict.textContent = "→ " + (act === "loc-approve" ? "approve" : "reject");
          else verdict.textContent = "→ " + (act === "web-ok" ? "show" : "hidden");
        }
        refreshProgress();
      }
    });
  });
}

document.getElementById("filters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("active", x === b));
  render();
});

fetch("/api/items").then((r) => r.json()).then((d) => { ITEMS = d.items; render(); });
</script>
</body>
</html>`;
