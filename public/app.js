/* ===== SoFlo Vegan Eateries — app logic ===== */
(() => {
  "use strict";

  const SETUP_KEY = "sofloveg_setup_done";

  const $ = (sel) => document.querySelector(sel);

  /* -------------------------------------------------- *
   *  Standalone / install detection
   * -------------------------------------------------- */
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  const guessPlatform = () => {
    const ua = navigator.userAgent || "";
    if (/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "ios";
    if (/android/i.test(ua)) return "android";
    return "android"; // sensible default for the install guide
  };

  const guessBrowser = () => {
    const ua = navigator.userAgent || "";
    if (/SamsungBrowser/i.test(ua)) return "samsung";
    if (/EdgA|Edge|Edg\//i.test(ua)) return "edge";
    if (/Firefox|FxiOS/i.test(ua)) return "firefox";
    return "chrome";
  };

  /* -------------------------------------------------- *
   *  Install instructions
   * -------------------------------------------------- */
  const INSTRUCTIONS = {
    ios: [
      'Tap the <span class="key">Share</span> button (the square with an up arrow) in Safari’s toolbar.',
      'Scroll down and tap <span class="key">Add to Home Screen</span>.',
      'Tap <span class="key">Add</span> in the top-right corner.',
      "Close Safari, then open the app from the new icon on your home screen.",
    ],
    android: {
      chrome: [
        'Tap the <span class="key">⋮</span> menu in the top-right of Chrome.',
        'Tap <span class="key">Add to Home screen</span> (or <span class="key">Install app</span>).',
        'Tap <span class="key">Add</span> / <span class="key">Install</span> to confirm.',
        "Open the app from the new icon on your home screen.",
      ],
      samsung: [
        'Tap the <span class="key">☰</span> menu at the bottom of Samsung Internet.',
        'Tap <span class="key">Add page to</span>, then choose <span class="key">Home screen</span>.',
        'Tap <span class="key">Add</span> to confirm.',
        "Open the app from the new icon on your home screen.",
      ],
      firefox: [
        'Tap the <span class="key">⋮</span> menu in Firefox.',
        'Tap <span class="key">Install</span> (or <span class="key">Add to Home screen</span>).',
        'Confirm by tapping <span class="key">Add</span>.',
        "Open the app from the new icon on your home screen.",
      ],
      edge: [
        'Tap the <span class="key">⋯</span> menu at the bottom of Edge.',
        'Tap <span class="key">Add to phone</span> (or <span class="key">Add to Home screen</span>).',
        'Tap <span class="key">Add</span> / <span class="key">Install</span> to confirm.',
        "Open the app from the new icon on your home screen.",
      ],
    },
  };

  const setupScreen = $("#setup-screen");
  const tabIos = $("#tab-ios");
  const tabAndroid = $("#tab-android");
  const browserPick = $("#browser-pick");
  const browserSelect = $("#browser-select");
  const stepsEl = $("#steps");

  let platform = guessPlatform();

  function renderSteps() {
    let steps;
    if (platform === "ios") {
      steps = INSTRUCTIONS.ios;
      browserPick.hidden = true;
    } else {
      browserPick.hidden = false;
      steps = INSTRUCTIONS.android[browserSelect.value] || INSTRUCTIONS.android.chrome;
    }
    stepsEl.innerHTML = steps.map((s) => `<li>${s}</li>`).join("");
    tabIos.setAttribute("aria-selected", String(platform === "ios"));
    tabAndroid.setAttribute("aria-selected", String(platform === "android"));
  }

  function openSetup() {
    platform = guessPlatform();
    browserSelect.value = guessBrowser();
    renderSteps();
    setupScreen.hidden = false;
    document.documentElement.scrollTop = 0;
  }

  function closeSetup(remember) {
    if (remember) {
      try { localStorage.setItem(SETUP_KEY, "1"); } catch (_) {}
    }
    setupScreen.hidden = true;
  }

  tabIos.addEventListener("click", () => { platform = "ios"; renderSteps(); });
  tabAndroid.addEventListener("click", () => { platform = "android"; renderSteps(); });
  browserSelect.addEventListener("change", renderSteps);
  $("#btn-done").addEventListener("click", () => closeSetup(true));
  $("#btn-help").addEventListener("click", openSetup);

  // Show the setup screen on first run only (skip if already installed/standalone).
  function maybeShowSetup() {
    let done = false;
    try { done = localStorage.getItem(SETUP_KEY) === "1"; } catch (_) {}
    if (!done && !isStandalone()) openSetup();
  }

  /* -------------------------------------------------- *
   *  Data loading + rendering
   * -------------------------------------------------- */
  const resultsEl = $("#results");
  const countEl = $("#result-count");
  let RESTAURANTS = [];

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function fillSelect(el, items, allLabel) {
    el.innerHTML =
      `<option value="">${allLabel}</option>` +
      items.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  }

  function renderLegend(legend) {
    const el = $("#legend");
    el.innerHTML =
      "<dl>" +
      legend
        .map(
          (l) =>
            `<div class="row"><dt><span class="badge badge--${l.code}">${l.code}</span></dt>` +
            `<dd><strong>${escapeHtml(l.label)}</strong> — ${escapeHtml(l.description)}</dd></div>`
        )
        .join("") +
      "</dl>";
  }

  function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url; }
  }

  // ISO timestamp -> "May 29, 2026". Returns "" if missing/invalid.
  function formatCheckedDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function cardHtml(r) {
    const badgeClass = r.type ? `badge--${r.type}` : "badge--none";
    const badgeText = r.type || "?";
    const cityBits = [];
    if (r.city) cityBits.push(escapeHtml(r.city));
    if (r.cuisine) cityBits.push(escapeHtml(r.cuisine));
    const outdoor = r.outdoorSeating ? `<span class="dot">·</span><span class="chip-outdoor">🌿 Outdoor seating</span>` : "";
    const link = r.website
      ? `<a class="card__link" href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(hostname(r.website))}</a>`
      : "";
    return (
      `<article class="card ${r.type === "V" ? "card--v" : ""}">` +
        `<div class="card__top">` +
          `<h3 class="card__name">${escapeHtml(r.name)}</h3>` +
          `<span class="badge ${badgeClass}" title="${escapeHtml(r.typeLabel || "Unknown")}">${badgeText}</span>` +
        `</div>` +
        `<div class="card__row">${cityBits.join('<span class="dot">·</span>')}${outdoor}</div>` +
        link +
      `</article>`
    );
  }

  function applyFilters() {
    const q = $("#search").value.trim().toLowerCase();
    const county = $("#filter-county").value;
    const type = $("#filter-type").value;
    const cuisine = $("#filter-cuisine").value;
    const outdoorOnly = $("#filter-outdoor").checked;

    const filtered = RESTAURANTS.filter((r) => {
      if (county && r.county !== county) return false;
      if (type && r.type !== type) return false;
      if (cuisine && r.cuisine !== cuisine) return false;
      if (outdoorOnly && !r.outdoorSeating) return false;
      if (q) {
        const hay = `${r.name} ${r.cuisine} ${r.city}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    countEl.textContent = `${filtered.length} of ${RESTAURANTS.length} places`;

    if (!filtered.length) {
      resultsEl.innerHTML = `<p class="empty">No restaurants match your filters.<br>Try clearing the search or filters.</p>`;
      return;
    }

    // Group by county, preserving the data's county order.
    const order = [...new Set(RESTAURANTS.map((r) => r.county))];
    const groups = new Map(order.map((c) => [c, []]));
    filtered.forEach((r) => groups.get(r.county).push(r));

    let html = "";
    for (const c of order) {
      const list = groups.get(c);
      if (!list.length) continue;
      html += `<h2 class="county-head">${escapeHtml(c)} (${list.length})</h2>`;
      html += list.map(cardHtml).join("");
    }
    resultsEl.innerHTML = html;
  }

  function initFilters(data) {
    const cuisines = [...new Set(RESTAURANTS.map((r) => r.cuisine).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b)
    );
    fillSelect($("#filter-county"), data.counties, "All counties");
    fillSelect(
      $("#filter-type"),
      data.legend.map((l) => l.code),
      "All types"
    );
    // Show a friendlier label for type options.
    const typeSel = $("#filter-type");
    data.legend.forEach((l) => {
      const opt = [...typeSel.options].find((o) => o.value === l.code);
      if (opt) opt.textContent = `${l.code} · ${l.label}`;
    });
    fillSelect($("#filter-cuisine"), cuisines, "All cuisines");

    ["search", "filter-county", "filter-type", "filter-cuisine", "filter-outdoor"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener(el.tagName === "INPUT" && el.type !== "checkbox" ? "input" : "change", applyFilters);
    });
  }

  function loadData() {
    fetch("data/restaurants.json", { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        RESTAURANTS = data.restaurants || [];
        const bits = [`${RESTAURANTS.length} places`];
        if (data.sourceUpdated) bits.push(`list updated ${data.sourceUpdated}`);
        const checked = formatCheckedDate(data.checkedAt);
        if (checked) bits.push(`data checked ${checked}`);
        $("#updated-note").textContent = bits.join(" · ");
        renderLegend(data.legend || []);
        initFilters(data);
        applyFilters();
      })
      .catch((err) => {
        $("#updated-note").textContent = "Could not load data.";
        resultsEl.innerHTML = `<p class="empty">Sorry, the restaurant list failed to load.<br>Please check your connection and reopen the app.</p>`;
        console.error("Data load failed:", err);
      });
  }

  // Legend toggle
  $("#legend-toggle").addEventListener("click", (e) => {
    const legend = $("#legend");
    const show = legend.hidden;
    legend.hidden = !show;
    e.currentTarget.setAttribute("aria-expanded", String(show));
  });

  /* -------------------------------------------------- *
   *  Boot
   * -------------------------------------------------- */
  $("#app").hidden = false;
  maybeShowSetup();
  loadData();

  // Service worker for offline support
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
    });
  }
})();
