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
  let commentCounts = new Map();

  // "Near me" state: the user's location (once granted) and whether we're currently
  // sorting by distance. userLoc is cached so toggling off/on doesn't re-prompt.
  let userLoc = null;
  let nearActive = false;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function restaurantKey(r) {
    const norm = (s) => (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${norm(r.name)}|${norm(r.city)}`;
  }

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

  // Great-circle distance in miles between two {lat,lng} points (haversine).
  function distanceMiles(a, b) {
    const R = 3958.8; // Earth radius, miles
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatMiles(d) {
    if (d < 0.1) return "< 0.1 mi";
    if (d < 10) return `${d.toFixed(1)} mi`;
    return `${Math.round(d)} mi`;
  }

  // Build a Google Maps directions URL that opens navigation to the place. We pass a
  // human-readable destination (name + address) plus the place ID when we have it, so
  // Maps resolves to the exact listing rather than a fuzzy text search.
  function mapsUrl(r) {
    const dest = r.address || r.name || (r.lat != null && r.lng != null ? `${r.lat},${r.lng}` : "");
    if (!dest && !r.placeId) return "";
    const params = new URLSearchParams({ api: "1", destination: dest || r.name || "" });
    if (r.placeId) params.set("destination_place_id", r.placeId);
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  // ISO timestamp -> "May 29, 2026". Returns "" if missing/invalid.
  function formatCheckedDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function cardHtml(r, dist) {
    const badgeClass = r.type ? `badge--${r.type}` : "badge--none";
    const badgeText = r.type || "?";
    // Distance chip, shown whenever location is known and the place has coordinates
    // (both in "Near me" mode and the normal county view).
    const distChip =
      typeof dist === "number" && isFinite(dist)
        ? `<span class="card__dist">📍 ${formatMiles(dist)} away</span>`
        : "";
    const cityBits = [];
    if (r.city) cityBits.push(escapeHtml(r.city));
    if (r.cuisine) cityBits.push(escapeHtml(r.cuisine));
    const outdoor = r.outdoorSeating ? `<span class="dot">·</span><span class="chip-outdoor">🌿 Outdoor seating</span>` : "";
    // A rename (e.g. the place rebranded) keeps a subtle pointer to the old name so
    // long-time regulars searching the former name still recognise it.
    const former = r.formerName
      ? `<div class="card__former">formerly ${escapeHtml(r.formerName)}</div>`
      : "";
    // Temporarily-closed (per Google Places). Permanently-closed places are dropped
    // upstream in build-data; these we keep but flag, with the date we last checked.
    let closed = "";
    if (r.closedTemporarily) {
      const since = formatCheckedDate(r.closedSince);
      closed = `<div class="card__closed">⏸️ Temporarily closed${since ? ` · as of ${since}` : ""}</div>`;
    }
    // A website confirmed down (404) is hidden so we never link users to a dead page.
    // The restaurant still shows — the place may well be open; only the link is gone.
    const websiteLink = r.website && r.websiteStatus !== "down"
      ? `<a class="card__link" href="${escapeHtml(r.website)}" target="_blank" rel="noopener">Website</a>`
      : "";
    // Google Maps directions link so people can navigate straight there. Prefer the
    // place ID (exact listing); fall back to address, then coordinates.
    const maps = mapsUrl(r);
    const mapsLink = maps
      ? `<a class="card__link card__link--maps" href="${escapeHtml(maps)}" target="_blank" rel="noopener">Directions</a>`
      : "";
    const key = restaurantKey(r);
    const count = commentCounts.get(key) || 0;
    const commentsBtn = `<button class="card__comments-btn" data-key="${escapeHtml(key)}" data-name="${escapeHtml(r.name)}">💬 ${count > 0 ? `Comments (${count})` : "Comments"}</button>`;
    const links = `<div class="card__links">${websiteLink}${mapsLink}${commentsBtn}</div>`;
    return (
      `<article class="card ${r.type === "V" ? "card--v" : ""}">` +
        `<div class="card__top">` +
          `<h3 class="card__name">${escapeHtml(r.name)}</h3>` +
          `<span class="badge ${badgeClass}" title="${escapeHtml(r.typeLabel || "Unknown")}">${badgeText}</span>` +
        `</div>` +
        former +
        `<div class="card__row">${distChip}${distChip && cityBits.length ? '<span class="dot">·</span>' : ""}${cityBits.join('<span class="dot">·</span>')}${outdoor}</div>` +
        closed +
        links +
      `</article>`
    );
  }

  function applyFilters() {
    const q = $("#search").value.trim().toLowerCase();
    const county = $("#filter-county").value;
    const type = $("#filter-type").value;
    const cuisine = $("#filter-cuisine").value;
    const outdoorOnly = $("#filter-outdoor").checked;
    updateFilterCount();

    const filtered = RESTAURANTS.filter((r) => {
      if (county && r.county !== county) return false;
      if (type && r.type !== type) return false;
      if (cuisine && r.cuisine !== cuisine) return false;
      if (outdoorOnly && !r.outdoorSeating) return false;
      if (q) {
        const hay = `${r.name} ${r.formerName || ""} ${r.cuisine} ${r.city}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    countEl.textContent = nearActive
      ? `${filtered.length} of ${RESTAURANTS.length} places · nearest first`
      : `${filtered.length} of ${RESTAURANTS.length} places`;

    if (!filtered.length) {
      resultsEl.innerHTML = `<p class="empty">No restaurants match your filters.<br>Try clearing the search or filters.</p>`;
      return;
    }

    // "Near me": one flat list sorted by distance (closest first). Places without
    // coordinates sort to the end and show no distance chip.
    if (nearActive && userLoc) {
      const withDist = filtered
        .map((r) => ({
          r,
          d: r.lat != null && r.lng != null ? distanceMiles(userLoc, r) : Infinity,
        }))
        .sort((a, b) => a.d - b.d);
      resultsEl.innerHTML = withDist.map(({ r, d }) => cardHtml(r, d)).join("");
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
      // Once location is known, show the distance chip here too (not just in Near-me mode).
      html += list
        .map((r) =>
          cardHtml(
            r,
            userLoc && r.lat != null && r.lng != null ? distanceMiles(userLoc, r) : undefined
          )
        )
        .join("");
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
        // Hidden rows (permanently closed or de-duplicated) stay in the JSON for the
        // record but never surface in the app.
        RESTAURANTS = (data.restaurants || []).filter((r) => !r.hidden);
        const bits = [`${RESTAURANTS.length} places`];
        if (data.sourceUpdated) bits.push(`list updated ${data.sourceUpdated}`);
        const checked = formatCheckedDate(data.checkedAt);
        if (checked) bits.push(`data checked ${checked}`);
        $("#updated-note").textContent = bits.join(" · ");
        renderLegend(data.legend || []);
        initFilters(data);
        applyFilters();
        fetch("/api/comment-counts")
          .then((r) => r.json())
          .then((data) => {
            commentCounts = new Map(Object.entries(data.counts || {}));
            applyFilters();
          })
          .catch(() => {});
      })
      .catch((err) => {
        $("#updated-note").textContent = "Could not load data.";
        resultsEl.innerHTML = `<p class="empty">Sorry, the restaurant list failed to load.<br>Please check your connection and reopen the app.</p>`;
        console.error("Data load failed:", err);
      });
  }

  /* -------------------------------------------------- *
   *  "Near me" — sort by distance from the user
   * -------------------------------------------------- */
  const nearBtn = $("#filter-near");
  const nearMsg = $("#near-msg");

  function setNearMsg(text) {
    if (!text) {
      nearMsg.hidden = true;
      nearMsg.textContent = "";
      return;
    }
    nearMsg.textContent = text;
    nearMsg.hidden = false;
  }

  function updateNearBtn() {
    nearBtn.setAttribute("aria-pressed", String(nearActive));
    nearBtn.classList.toggle("is-active", nearActive);
    nearBtn.querySelector(".near-btn__label").textContent = nearActive ? "Near me · on" : "Near me";
  }

  function requestNearMe() {
    if (!("geolocation" in navigator)) {
      setNearMsg("Location isn’t available on this device.");
      return;
    }
    nearBtn.disabled = true;
    nearBtn.querySelector(".near-btn__label").textContent = "Locating…";
    setNearMsg("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearActive = true;
        nearBtn.disabled = false;
        updateNearBtn();
        applyFilters();
      },
      (err) => {
        nearBtn.disabled = false;
        nearActive = false;
        updateNearBtn();
        setNearMsg(
          err && err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Allow location access to sort by distance."
            : "Couldn’t get your location. Please try again."
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }

  nearBtn.addEventListener("click", () => {
    if (nearActive) {
      // Toggle back to the default county-grouped view (keep userLoc cached).
      nearActive = false;
      updateNearBtn();
      applyFilters();
      return;
    }
    setNearMsg("");
    if (userLoc) {
      nearActive = true;
      updateNearBtn();
      applyFilters();
      return;
    }
    requestNearMe();
  });

  /* -------------------------------------------------- *
   *  Comments modal
   * -------------------------------------------------- */
  const commentsModal = $("#comments-modal");
  const modalTitle = $("#modal-title");
  const commentsList = $("#comments-list");
  const commentForm = $("#comment-form");
  const commentFormMsg = $("#comment-form-msg");
  let currentCommentKey = null;

  function starsHtml(rating) {
    if (!rating) return "";
    return `<span class="comment__stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>`;
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function renderComments(comments) {
    if (!comments.length) {
      commentsList.innerHTML = `<p class="comments-empty">No comments yet — be the first!</p>`;
      return;
    }
    commentsList.innerHTML = comments
      .map(
        (c) =>
          `<div class="comment">` +
            `<div class="comment__meta">` +
              `<span class="comment__author">${escapeHtml(c.author)}</span>` +
              starsHtml(c.rating) +
              `<span class="comment__time">${timeAgo(c.created_at)}</span>` +
            `</div>` +
            `<p class="comment__body">${escapeHtml(c.body)}</p>` +
          `</div>`
      )
      .join("");
  }

  async function fetchComments(key) {
    commentsList.innerHTML = `<p class="comments-loading">Loading…</p>`;
    try {
      const res = await fetch(`/api/comments?key=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      renderComments(data.comments || []);
    } catch {
      commentsList.innerHTML = `<p class="comments-empty">Could not load comments. Please try again.</p>`;
    }
  }

  function openCommentsModal(key, name) {
    currentCommentKey = key;
    modalTitle.textContent = name;
    commentsModal.hidden = false;
    document.body.style.overflow = "hidden";
    commentForm.reset();
    commentFormMsg.hidden = true;
    fetchComments(key);
  }

  function closeCommentsModal() {
    commentsModal.hidden = true;
    document.body.style.overflow = "";
    currentCommentKey = null;
  }

  $("#modal-close").addEventListener("click", closeCommentsModal);
  commentsModal.addEventListener("click", (e) => {
    if (e.target === commentsModal || e.target.classList.contains("modal__backdrop")) {
      closeCommentsModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !commentsModal.hidden) closeCommentsModal();
  });

  commentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const honeypot = commentForm.querySelector('[name="website"]').value;
    const body = $("#comment-body").value.trim();
    const author = $("#comment-author").value.trim() || "Anonymous";
    const ratingVal = $("#comment-rating").value ? parseInt($("#comment-rating").value, 10) : null;

    if (!body) {
      commentFormMsg.textContent = "Please write a comment before posting.";
      commentFormMsg.className = "comment-form__msg comment-form__msg--error";
      commentFormMsg.hidden = false;
      return;
    }

    const submitBtn = commentForm.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Posting…";
    commentFormMsg.hidden = true;

    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: currentCommentKey, author, rating: ratingVal, body, honeypot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unknown error");
      commentForm.reset();
      commentFormMsg.textContent = "Comment posted!";
      commentFormMsg.className = "comment-form__msg comment-form__msg--ok";
      commentFormMsg.hidden = false;
      const newCount = (commentCounts.get(currentCommentKey) || 0) + 1;
      commentCounts.set(currentCommentKey, newCount);
      document.querySelectorAll(`.card__comments-btn[data-key="${currentCommentKey}"]`).forEach((btn) => {
        btn.textContent = `💬 Comments (${newCount})`;
      });
      fetchComments(currentCommentKey);
    } catch (err) {
      commentFormMsg.textContent = err.message || "Failed to post. Please try again.";
      commentFormMsg.className = "comment-form__msg comment-form__msg--error";
      commentFormMsg.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Post comment";
    }
  });

  /* -------------------------------------------------- *
   *  Filters panel — collapsed by default to give the
   *  listing more room. A badge shows how many are active.
   * -------------------------------------------------- */
  const filtersPanel = $("#filters");
  const filtersToggle = $("#filters-toggle");
  const filtersCount = $("#filters-count");

  function updateFilterCount() {
    let n = 0;
    if ($("#filter-county").value) n++;
    if ($("#filter-type").value) n++;
    if ($("#filter-cuisine").value) n++;
    if ($("#filter-outdoor").checked) n++;
    if (n > 0) {
      filtersCount.textContent = String(n);
      filtersCount.hidden = false;
    } else {
      filtersCount.hidden = true;
    }
  }

  filtersToggle.addEventListener("click", () => {
    const show = filtersPanel.hidden;
    filtersPanel.hidden = !show;
    filtersToggle.setAttribute("aria-expanded", String(show));
  });

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
  // Event delegation for comments buttons — cards are re-rendered on every filter
  // change so we can't attach listeners directly to buttons.
  resultsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".card__comments-btn");
    if (btn) openCommentsModal(btn.dataset.key, btn.dataset.name);
  });

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
