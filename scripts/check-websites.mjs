// Checks every restaurant website and reports its HTTP status.
// Usage: node scripts/check-websites.mjs [--all] [--write] [--concurrency=10] [--timeout=10000] [--html=path]
//   --all        also list sites that returned 200 in the console (default: only problems)
//   --write      flag confirmed-404 sites in restaurants.json (websiteStatus: "down") and
//                clear the flag on any that return 200 again. The app hides down links.
//   --html=path  write an HTML report (default: website-report.html in the project root)
//
// Each unique URL is checked once, then any restaurants sharing it are listed together.
// A browser-like User-Agent is sent so anti-bot servers don't return spurious 403/402.
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
};
const showAll = args.includes("--all");
const doWrite = args.includes("--write");
const CONCURRENCY = Number(flag("concurrency", 10));
const TIMEOUT = Number(flag("timeout", 10000));
const HTML_PATH = flag("html", new URL("../website-report.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DATA_URL = new URL("../public/data/restaurants.json", import.meta.url);

// A real browser UA + typical Accept headers. Many sites 403/402 a bare fetch.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const data = JSON.parse(await readFile(DATA_URL));

// De-duplicate by URL: one check per unique site, remembering every restaurant that uses it.
const byUrl = new Map();
for (const r of data.restaurants) {
  if (!r.website) continue;
  if (!byUrl.has(r.website)) byUrl.set(r.website, []);
  byUrl.get(r.website).push(r.name);
}
const sites = [...byUrl.entries()].map(([url, names]) => ({ url, names }));

async function check({ url, names }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    // Some servers reject HEAD, so fall back to GET on a non-2xx HEAD.
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: HEADERS });
    }
    return { url, names, status: res.status, ok: res.ok };
  } catch (err) {
    return { url, names, status: null, ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Simple concurrency pool.
const results = [];
let i = 0;
async function worker() {
  while (i < sites.length) {
    results.push(await check(sites[i++]));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const label = (r) => r.names.length > 1 ? `${r.names[0]} (+${r.names.length - 1} more)` : r.names[0];
const problems = results.filter((r) => !r.ok);
const okCount = results.length - problems.length;

// Sort each bucket by the first restaurant name for easy scanning.
const byName = (a, b) => a.names[0].localeCompare(b.names[0]);

// --- Categorize -------------------------------------------------------------
// 403/401/402/429/400 and timeouts are almost always anti-bot blocking or social
// pages (Facebook), not dead sites — flag them for a manual browser check rather
// than treating them as broken. A clean 404 likely IS a dead/moved page worth
// verifying. Anything else (DNS/TLS failures, odd 5xx) goes in "unreachable".
const BLOCK_STATUSES = new Set([400, 401, 402, 403, 429]);
const passing = results.filter((r) => r.ok).sort(byName);
const notFound = problems.filter((r) => r.status === 404).sort(byName);
const blocked = problems
  .filter((r) => BLOCK_STATUSES.has(r.status) || r.error === "timeout")
  .sort(byName);
const unreachable = problems
  .filter((r) => r !== undefined && !notFound.includes(r) && !blocked.includes(r))
  .sort(byName);

// --- Console summary --------------------------------------------------------
if (showAll) {
  for (const r of passing) console.log(`OK   ${r.status}  ${label(r)} — ${r.url}`);
}
for (const r of problems.sort(byName)) {
  console.log(`FAIL ${r.status ?? r.error}  ${label(r)} — ${r.url}`);
}
console.log(
  `\n${okCount}/${results.length} unique sites returned 200 ` +
    `(${data.restaurants.length} restaurants). ${problems.length} problem(s).`
);

// --- HTML report ------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rowsFor = (list) =>
  list
    .map((r) => {
      const reason = r.status ?? r.error ?? "—";
      const who = r.names.map(esc).join(", ");
      return `      <tr>
        <td>${esc(who)}</td>
        <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
        <td class="status">${esc(reason)}</td>
      </tr>`;
    })
    .join("\n");

const section = (id, title, blurb, list, cls) => `
  <section>
    <h2 id="${id}" class="${cls}">${esc(title)} <span class="count">${list.length}</span></h2>
    <p class="blurb">${esc(blurb)}</p>
    ${list.length ? `<table>
      <thead><tr><th>Restaurant(s)</th><th>Website</th><th>Status</th></tr></thead>
      <tbody>
${rowsFor(list)}
      </tbody>
    </table>` : `<p class="empty">None.</p>`}
  </section>`;

const generated = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restaurant Website Check</title>
<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 1000px; margin-inline: auto; color: #1a1a1a; background: #fafafa; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #666; font-size: .9rem; margin-bottom: 1.5rem; }
  .summary { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 2rem; }
  .summary a { text-decoration: none; padding: .5rem .9rem; border-radius: 8px; color: #fff; font-weight: 600; font-size: .9rem; }
  .pass-bg { background: #1b873f; } .notfound-bg { background: #c0392b; }
  .blocked-bg { background: #b8860b; } .unreach-bg { background: #555; }
  section { margin-bottom: 2.5rem; }
  h2 { display: flex; align-items: center; gap: .5rem; padding-bottom: .3rem; border-bottom: 2px solid #eee; }
  h2.pass { color: #1b873f; } h2.notfound { color: #c0392b; }
  h2.blocked { color: #b8860b; } h2.unreach { color: #555; }
  .count { font-size: .8rem; background: #eee; color: #333; border-radius: 999px; padding: .1rem .6rem; }
  .blurb { color: #555; font-size: .9rem; margin-top: .25rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #888; font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td a { color: #1565c0; word-break: break-all; }
  .status { font-variant-numeric: tabular-nums; white-space: nowrap; color: #444; }
  .empty { color: #999; font-style: italic; }
  tbody tr:hover { background: #fff; }
</style>
</head>
<body>
  <h1>Restaurant Website Check</h1>
  <p class="meta">Generated ${esc(generated)} ET · ${results.length} unique sites across ${data.restaurants.length} restaurants · browser User-Agent sent · each URL checked once</p>

  <div class="summary">
    <a class="pass-bg" href="#passing">✓ Passing ${passing.length}</a>
    <a class="notfound-bg" href="#notfound">404 — verify ${notFound.length}</a>
    <a class="blocked-bg" href="#blocked">Suspected blocked ${blocked.length}</a>
    <a class="unreach-bg" href="#unreachable">Unreachable ${unreachable.length}</a>
  </div>
${section("passing", "Passing (HTTP 200)", "These returned 200. No action needed.", passing, "pass")}
${section("notfound", "404 — Not Found (please verify)", "The server responded but the page is gone. Likely dead or moved — open each and confirm before fixing or removing.", notFound, "notfound")}
${section("blocked", "Suspected blocked (manual test)", "403/401/402/429/400 or a timeout. Usually anti-bot protection (Cloudflare) or social pages (Facebook rejects non-browser requests), NOT a dead site. Open each in a real browser to confirm it loads.", blocked, "blocked")}
${section("unreachable", "Unreachable (DNS/TLS/connection)", "The request never completed — bad domain, expired certificate, or server down. Open each to see whether it's truly gone.", unreachable, "unreach")}
</body>
</html>
`;

await writeFile(HTML_PATH, html);
console.log(`\nHTML report written to ${HTML_PATH}`);
console.log(
  `  Passing ${passing.length} · 404 ${notFound.length} · suspected blocked ${blocked.length} · unreachable ${unreachable.length}`
);

// --- Persist the down flag (only with --write) ------------------------------
// Confidence rule: a clean 404 means the page is genuinely gone, so flag it down.
// A 200 means it's up, so clear any stale flag. Everything else (blocked/timeout/
// unreachable) is left untouched — we can't tell "blocked" from "dead", and we'd
// rather keep a maybe-working link than hide a live restaurant on a false positive.
if (doWrite) {
  const downUrls = new Set(notFound.map((r) => r.url));
  const upUrls = new Set(passing.map((r) => r.url));
  const today = new Date().toISOString().slice(0, 10);
  let flagged = 0;
  let cleared = 0;
  for (const r of data.restaurants) {
    if (downUrls.has(r.website)) {
      if (r.websiteStatus !== "down") flagged++;
      r.websiteStatus = "down";
      r.websiteCheckedAt = today;
    } else if (upUrls.has(r.website) && r.websiteStatus === "down") {
      // Back online — un-flag it.
      delete r.websiteStatus;
      r.websiteCheckedAt = today;
      cleared++;
    }
  }
  await writeFile(DATA_URL, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `\nUpdated restaurants.json: flagged ${flagged} newly-down, cleared ${cleared} back-online ` +
      `(${[...new Set(data.restaurants.filter((r) => r.websiteStatus === "down").map((r) => r.website))].length} total down).`
  );
}

process.exit(problems.length ? 1 : 0);
