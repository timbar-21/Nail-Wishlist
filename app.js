"use strict";

/* ── config ────────────────────────────────────────────────── */
const STORAGE_KEY = "krista-nail-journal-v1";
const CLOUD_KEY = "krista-nail-journal-cloud-hash";

/* Cross-device sync via Firebase Firestore + Storage, set up once in a
   NEW Firebase project (console.firebase.google.com, free tier) — kept
   separate from any other app's project. Fill in the real values below
   and re-deploy to turn syncing on; until then FIREBASE_ENABLED stays
   false and the app runs local-only. This config is meant to be public
   (that's how Firebase client config works); real access control lives
   in firestore.rules/storage.rules, which restrict every read/write to
   paths keyed by the passcode's SHA-256 hash below — the passcode itself
   never leaves the device, only its hash does. See README.md for setup
   steps, and double-check the deployed rules in the Firebase console —
   they can't be verified from this client code alone. */
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
const FIREBASE_ENABLED = !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf("YOUR_") !== 0);

/* On by default (unlike the wine app, which left this off) — every
   device needs the shared passcode before it can read or write designs. */
const REQUIRE_PASSCODE = true;
const DEFAULT_CLOUD_DOC = "shared";

/* ── taxonomy ──────────────────────────────────────────────── */
const OCCASIONS = ["Wedding", "Holiday", "Vacation", "Everyday", "Date Night", "Interview"];
const SEASONS = ["Spring", "Summer", "Fall", "Winter"];
const DEFAULT_COLORS = ["Blue", "Green", "Light Pink"];
const TECHNIQUES = ["Gel", "Acrylic", "Dip Powder", "Press-On", "Regular Polish"];
const SHAPES = ["Almond", "Square", "Coffin", "Round", "Oval", "Stiletto"];
const RATING_TIERS = [
  { id: "love", label: "Love", level: 1, hex: "#D66E8C" },
  { id: "like", label: "Like", level: 0.72, hex: "#649EBE" },
  { id: "meh", label: "Meh", level: 0.34, hex: "#839C69" },
  { id: "skip", label: "Skip", level: 0, hex: "#A79E96" }
];

/* ── small helpers ─────────────────────────────────────────── */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function debounce(fn, ms) {
  let t;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
function hashPasscode(text) {
  return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim())).then(bufferToHex);
}

function downscaleImage(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("toBlob failed")); }, "image/jpeg", quality);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}
function blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ── local store ───────────────────────────────────────────── */
function loadStore() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      designs: s.designs || [],
      wishlist: s.wishlist || [],
      customColors: s.customColors || []
    };
  } catch (e) {
    return { designs: [], wishlist: [], customColors: [] };
  }
}
function saveStoreLocal() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      designs: state.designs, wishlist: state.wishlist, customColors: state.customColors
    }));
  } catch (e) {}
}

const state = Object.assign({
  filters: {
    gallery: { query: "", occasion: null, season: null, color: null, rating: null, sort: "date" },
    wishlist: { query: "", occasion: null, season: null, color: null, status: null }
  },
  syncStatus: ""
}, loadStore());

function allColors() {
  return DEFAULT_COLORS.concat(state.customColors.filter(function (c) { return DEFAULT_COLORS.indexOf(c) === -1; }));
}

/* ── passcode / lock state ─────────────────────────────────── */
let savedHash = null;
try { savedHash = window.localStorage.getItem(CLOUD_KEY); } catch (e) {}
let unlocked = !FIREBASE_ENABLED || !REQUIRE_PASSCODE || (REQUIRE_PASSCODE && !!savedHash);

/* ── Firebase (Firestore + Storage) ───────────────────────────
   One parent doc per passcode hash holds two subcollections — designs
   and wishlist — so each item is its own document (not one big blob),
   letting devices merge independent additions/edits without clobbering
   each other. Photos live in Storage under the same hash prefix. */
let db = null, storage = null, designsColRef = null, wishlistColRef = null;
let unsubDesigns = null, unsubWishlist = null, firebaseLoading = null, passcodeHash = null;

function ensureFirebase() {
  if (window.firebase && window.firebase.apps && window.firebase.apps.length) return Promise.resolve();
  if (firebaseLoading) return firebaseLoading;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load Firebase")); };
      document.head.appendChild(s);
    });
  }
  firebaseLoading = loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js")
    .then(function () { return loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js"); })
    .then(function () { return loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-storage-compat.js"); })
    .then(function () { window.firebase.initializeApp(FIREBASE_CONFIG); });
  return firebaseLoading;
}

function setSyncStatus(text) {
  state.syncStatus = text;
  const el = document.getElementById("sync-status");
  if (el) el.textContent = text;
}

function mergeById(remoteList, localOnlyList) {
  const map = new Map();
  remoteList.concat(localOnlyList).forEach(function (item) { map.set(item.id, item); });
  return Array.from(map.values());
}

function connectCloud(hash) {
  passcodeHash = hash;
  setSyncStatus("Connecting…");
  ensureFirebase().then(function () {
    db = window.firebase.firestore();
    storage = window.firebase.storage();
    const parent = db.collection("passcodes").doc(hash);
    designsColRef = parent.collection("designs");
    wishlistColRef = parent.collection("wishlist");
    return Promise.all([designsColRef.get(), wishlistColRef.get()]);
  }).then(function (results) {
    const designsSnap = results[0], wishlistSnap = results[1];
    const remoteDesignIds = new Set(designsSnap.docs.map(function (d) { return d.id; }));
    const remoteWishIds = new Set(wishlistSnap.docs.map(function (d) { return d.id; }));
    const localOnlyDesigns = state.designs.filter(function (d) { return !remoteDesignIds.has(d.id); });
    const localOnlyWish = state.wishlist.filter(function (w) { return !remoteWishIds.has(w.id); });
    const remoteDesigns = designsSnap.docs.map(function (d) { return d.data(); });
    const remoteWish = wishlistSnap.docs.map(function (d) { return d.data(); });
    state.designs = mergeById(remoteDesigns, localOnlyDesigns);
    state.wishlist = mergeById(remoteWish, localOnlyWish);
    saveStoreLocal();
    refreshDataViews();
    const writes = localOnlyDesigns.map(function (d) { return designsColRef.doc(d.id).set(d); })
      .concat(localOnlyWish.map(function (w) { return wishlistColRef.doc(w.id).set(w); }));
    return Promise.all(writes);
  }).then(function () {
    subscribeCloud();
    setSyncStatus("Synced");
  }).catch(function () {
    setSyncStatus("Offline — saved on this device, will sync when reconnected.");
  });
}

function subscribeCloud() {
  unsubDesigns = designsColRef.onSnapshot(function (snap) {
    if (snap.metadata.hasPendingWrites) return;
    snap.docChanges().forEach(function (change) {
      if (change.type === "removed") {
        state.designs = state.designs.filter(function (d) { return d.id !== change.doc.id; });
      } else {
        const data = change.doc.data();
        const idx = state.designs.findIndex(function (d) { return d.id === data.id; });
        if (idx >= 0) state.designs[idx] = data; else state.designs.unshift(data);
      }
    });
    saveStoreLocal();
    refreshDataViews();
    setSyncStatus("Synced");
  }, function () {
    setSyncStatus("Offline — saved on this device, will sync when reconnected.");
  });
  unsubWishlist = wishlistColRef.onSnapshot(function (snap) {
    if (snap.metadata.hasPendingWrites) return;
    snap.docChanges().forEach(function (change) {
      if (change.type === "removed") {
        state.wishlist = state.wishlist.filter(function (w) { return w.id !== change.doc.id; });
      } else {
        const data = change.doc.data();
        const idx = state.wishlist.findIndex(function (w) { return w.id === data.id; });
        if (idx >= 0) state.wishlist[idx] = data; else state.wishlist.unshift(data);
      }
    });
    saveStoreLocal();
    refreshDataViews();
    setSyncStatus("Synced");
  }, function () {
    setSyncStatus("Offline — saved on this device, will sync when reconnected.");
  });
}

/* Falls back to an embedded data: URL when Storage isn't configured or
   reachable — local-only, but never blocks saving a design. */
function uploadPhoto(blob, pathHint) {
  if (!(FIREBASE_ENABLED && storage && passcodeHash)) return blobToDataURL(blob);
  const path = "photos/" + passcodeHash + "/" + pathHint + "-" + Date.now() + ".jpg";
  const ref = storage.ref().child(path);
  return ref.put(blob, { contentType: "image/jpeg" }).then(function () { return ref.getDownloadURL(); }).catch(function () {
    return blobToDataURL(blob);
  });
}

/* ── design / wishlist CRUD ────────────────────────────────── */
function upsertDesign(design) {
  const idx = state.designs.findIndex(function (d) { return d.id === design.id; });
  if (idx >= 0) state.designs[idx] = design; else state.designs.unshift(design);
  saveStoreLocal();
  refreshDataViews();
  if (designsColRef) designsColRef.doc(design.id).set(design).catch(function () {});
}
function removeDesign(id) {
  state.designs = state.designs.filter(function (d) { return d.id !== id; });
  const affected = state.wishlist.filter(function (w) { return w.resultDesignId === id; });
  affected.forEach(function (w) { w.resultDesignId = null; });
  saveStoreLocal();
  refreshDataViews();
  if (designsColRef) designsColRef.doc(id).delete().catch(function () {});
  affected.forEach(function (w) { if (wishlistColRef) wishlistColRef.doc(w.id).set(w).catch(function () {}); });
}
function upsertWishlist(item) {
  const idx = state.wishlist.findIndex(function (w) { return w.id === item.id; });
  if (idx >= 0) state.wishlist[idx] = item; else state.wishlist.unshift(item);
  saveStoreLocal();
  refreshDataViews();
  if (wishlistColRef) wishlistColRef.doc(item.id).set(item).catch(function () {});
}
function removeWishlist(id) {
  state.wishlist = state.wishlist.filter(function (w) { return w.id !== id; });
  const affected = state.designs.filter(function (d) { return d.wishlistId === id; });
  affected.forEach(function (d) { d.wishlistId = null; });
  saveStoreLocal();
  refreshDataViews();
  if (wishlistColRef) wishlistColRef.doc(id).delete().catch(function () {});
  affected.forEach(function (d) { if (designsColRef) designsColRef.doc(d.id).set(d).catch(function () {}); });
}

/* ── icons ─────────────────────────────────────────────────── */
let iconCounter = 0;
const BOTTLE_PATH = "M9 7 L7 12 L7 26 A5 5 0 0 0 12 31 A5 5 0 0 0 17 26 L17 12 L15 7 Z";
/* A little polish bottle, filled to the tier's level and tinted through
   the accent palette (pink -> blue -> sage -> gray) as it steps down;
   "skip" tips the bottle rather than filling it. */
function ratingIconSVG(tier, size, className) {
  const cfg = RATING_TIERS.find(function (r) { return r.id === tier; });
  const cls = className ? ' class="' + className + '"' : "";
  if (!cfg) {
    return '<svg' + cls + ' width="' + size + '" height="' + Math.round(size * 1.33) + '" viewBox="0 0 24 32" fill="none" stroke="#C9C0B8" stroke-width="1.6">' +
      '<rect x="8" y="2" width="8" height="5" rx="1.5"></rect><path d="' + BOTTLE_PATH + '"></path></svg>';
  }
  const clipId = "liq" + (iconCounter++);
  const bodyTop = 12, bodyBottom = 30, bodyH = bodyBottom - bodyTop;
  const liquidH = bodyH * cfg.level;
  const liquidY = bodyBottom - liquidH;
  const tiltAttr = tier === "skip" ? ' style="transform:rotate(24deg);transform-origin:12px 30px;"' : "";
  return '<svg' + cls + ' width="' + size + '" height="' + Math.round(size * 1.33) + '" viewBox="0 0 24 32" fill="none"' + tiltAttr + '>' +
    '<clipPath id="' + clipId + '"><path d="' + BOTTLE_PATH + '"></path></clipPath>' +
    '<rect x="8" y="2" width="8" height="5" rx="1.5" fill="' + cfg.hex + '"></rect>' +
    '<path d="' + BOTTLE_PATH + '" stroke="' + cfg.hex + '" stroke-width="1.6" fill="#fff"></path>' +
    (liquidH > 0 ? '<rect x="6" y="' + liquidY + '" width="12" height="' + (liquidH + 2) + '" fill="' + cfg.hex + '" clip-path="url(#' + clipId + ')"></rect>' : "") +
    "</svg>";
}
function ratingLabel(tier) {
  const cfg = RATING_TIERS.find(function (r) { return r.id === tier; });
  return cfg ? cfg.label : "Not rated";
}
function backArrowSVG() { return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19l-7-7 7-7"></path></svg>'; }
function editSVG() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>'; }
function trashSVG() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>'; }
function cameraGlyphSVG() { return '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7l1.5-2.5h5L16 7"></path><circle cx="12" cy="13.5" r="3.5"></circle></svg>'; }

/* ── chips + filtering ─────────────────────────────────────── */
function chipHTML(group, value, label, active, tone, mode) {
  return '<button type="button" class="chip' + (active ? " active" : "") + '" data-chip-mode="' + mode + '" data-chip-group="' + group + '" data-chip-value="' + esc(value) + '" data-tone="' + tone + '">' + esc(label) + "</button>";
}
function matchesFilters(item, f) {
  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = [item.notes, item.location, item.artistName, item.artistHandle, item.title].filter(Boolean).join(" ").toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  if (f.occasion && (item.occasion || []).indexOf(f.occasion) === -1) return false;
  if (f.season && item.season !== f.season) return false;
  if (f.color && (item.colors || []).indexOf(f.color) === -1) return false;
  if (f.rating && item.rating !== f.rating) return false;
  if (f.status && item.status !== f.status) return false;
  return true;
}
function sortDesigns(list, sort) {
  const arr = list.slice();
  if (sort === "rating") {
    const order = { love: 0, like: 1, meh: 2, skip: 3, "": 4 };
    arr.sort(function (a, b) {
      const ra = order[a.rating] === undefined ? 4 : order[a.rating];
      const rb = order[b.rating] === undefined ? 4 : order[b.rating];
      return ra - rb || (b.dateLogged || "").localeCompare(a.dateLogged || "");
    });
  } else {
    arr.sort(function (a, b) { return (b.dateLogged || "").localeCompare(a.dateLogged || ""); });
  }
  return arr;
}

/* ── router ────────────────────────────────────────────────── */
function parseRoute() {
  const parts = (location.hash || "#/gallery").slice(1).split("/").filter(Boolean);
  return { name: parts[0] || "gallery", parts: parts };
}
function navigate(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}
function updateNavActive(name, parts) {
  const tab = name === "wishlist" ? "wishlist" : (name === "design" && parts[1] === "new") ? "add" : "gallery";
  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.nav === tab);
  });
}
function renderRoute() {
  const r = parseRoute(), name = r.name, parts = r.parts;
  updateNavActive(name, parts);
  const root = document.getElementById("view-root");
  const title = document.getElementById("header-title");
  if (name === "wishlist" && parts[1] === "add") {
    title.textContent = "Add to Wishlist";
    initWishlistDraft(null);
    root.innerHTML = wishlistFormBodyHTML();
    bindWishlistFormEvents(null);
  } else if (name === "wishlist" && parts[1] && parts[2] === "edit") {
    title.textContent = "Edit Wishlist Item";
    initWishlistDraft(parts[1]);
    root.innerHTML = wishlistFormBodyHTML();
    bindWishlistFormEvents(parts[1]);
  } else if (name === "wishlist" && parts[1]) {
    title.textContent = "Wishlist Item";
    root.innerHTML = wishlistDetailHTML(parts[1]);
    bindWishlistDetailEvents(parts[1]);
  } else if (name === "wishlist") {
    title.textContent = "Wishlist";
    root.innerHTML = wishlistHTML();
    bindWishlistEvents();
  } else if (name === "design" && parts[1] === "new") {
    const fromWishlistId = parts[2] === "from" ? parts[3] : null;
    title.textContent = "Add Design";
    initDesignDraft(null, fromWishlistId);
    root.innerHTML = designFormBodyHTML();
    bindDesignFormEvents(null);
  } else if (name === "design" && parts[1] && parts[2] === "edit") {
    title.textContent = "Edit Design";
    initDesignDraft(parts[1], null);
    root.innerHTML = designFormBodyHTML();
    bindDesignFormEvents(parts[1]);
  } else if (name === "design" && parts[1]) {
    title.textContent = "Design";
    root.innerHTML = designDetailHTML(parts[1]);
    bindDesignDetailEvents(parts[1]);
  } else {
    title.textContent = "Gallery";
    root.innerHTML = galleryHTML();
    bindGalleryEvents();
  }
}
/* Refreshes list views after a local edit or an incoming remote change,
   without touching an in-progress Add/Edit form (which owns its own
   draft object and would otherwise lose unsaved input). */
function refreshDataViews() {
  const r = parseRoute();
  if (r.name === "gallery" && document.getElementById("gallery-grid")) updateGalleryResults();
  else if (r.name === "wishlist" && !r.parts[1] && document.getElementById("wishlist-list")) updateWishlistResults();
}
function notFoundHTML() {
  return '<div class="empty-state"><div class="empty-title">Not found</div><div class="empty-body">This item may have been deleted.</div></div>';
}

/* ── gallery ───────────────────────────────────────────────── */
function galleryHTML() {
  const f = state.filters.gallery;
  return "" +
    '<input id="gallery-search" class="search-input" type="search" placeholder="Search notes, location, artist…" value="' + esc(f.query) + '">' +
    '<div class="filter-group"><div class="filter-label">Occasion</div><div class="chip-row">' +
      OCCASIONS.map(function (o) { return chipHTML("occasion", o, o, f.occasion === o, "pink", "filter-gallery"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Season</div><div class="chip-row">' +
      SEASONS.map(function (s) { return chipHTML("season", s, s, f.season === s, "blue", "filter-gallery"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Color</div><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("color", c, c, f.color === c, "sage", "filter-gallery"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Rating</div><div class="chip-row">' +
      RATING_TIERS.map(function (r) { return chipHTML("rating", r.id, r.label, f.rating === r.id, "neutral", "filter-gallery"); }).join("") + "</div></div>" +
    '<div class="filters-bar"><span class="result-line" id="gallery-result-line"></span>' +
      '<button type="button" class="btn-text" id="gallery-sort-toggle"></button></div>' +
    '<div id="gallery-grid"></div>';
}
function designCardHTML(d) {
  const photo = d.photoUrl
    ? '<img class="card-photo" src="' + esc(d.photoUrl) + '" loading="lazy" alt="">'
    : '<div class="card-photo-empty">' + cameraGlyphSVG() + "</div>";
  const titleText = d.location || (d.occasion && d.occasion[0]) || "Untitled";
  return '<div class="card" data-open-design="' + d.id + '">' + photo +
    '<div class="card-body"><div class="card-title">' + esc(titleText) + '</div>' +
    '<div class="card-meta">' + ratingIconSVG(d.rating, 16, "card-rating") + "<span>" + esc(formatDate(d.dateLogged)) + "</span></div>" +
    "</div></div>";
}
function updateGalleryResults() {
  const f = state.filters.gallery;
  let list = state.designs.filter(function (d) { return matchesFilters(d, f); });
  list = sortDesigns(list, f.sort);
  document.getElementById("gallery-result-line").textContent = list.length + (list.length === 1 ? " design" : " designs");
  document.getElementById("gallery-sort-toggle").textContent = f.sort === "date" ? "Sort: Newest" : "Sort: Rating";
  const grid = document.getElementById("gallery-grid");
  if (!list.length) {
    const hasAny = state.designs.length > 0;
    grid.innerHTML = '<div class="empty-state"><div class="empty-title">' + (hasAny ? "No matches" : "No designs yet") +
      '</div><div class="empty-body">' + (hasAny ? "Try clearing a filter." : "Tap the + button to log your first manicure.") + "</div></div>";
    return;
  }
  grid.innerHTML = '<div class="grid">' + list.map(designCardHTML).join("") + "</div>";
}
function bindGalleryEvents() {
  updateGalleryResults();
  const root = document.getElementById("view-root");
  const search = document.getElementById("gallery-search");
  search.addEventListener("input", debounce(function () {
    state.filters.gallery.query = search.value;
    updateGalleryResults();
  }, 150));
  root.querySelectorAll('[data-chip-mode="filter-gallery"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const group = btn.dataset.chipGroup, value = btn.dataset.chipValue;
      const f = state.filters.gallery;
      f[group] = f[group] === value ? null : value;
      renderRoute();
    });
  });
  document.getElementById("gallery-sort-toggle").addEventListener("click", function () {
    state.filters.gallery.sort = state.filters.gallery.sort === "date" ? "rating" : "date";
    updateGalleryResults();
  });
  document.getElementById("gallery-grid").addEventListener("click", function (e) {
    const card = e.target.closest("[data-open-design]");
    if (card) navigate("#/design/" + card.dataset.openDesign);
  });
}

/* ── design detail ─────────────────────────────────────────── */
function designDetailHTML(id) {
  const d = state.designs.find(function (x) { return x.id === id; });
  if (!d) return notFoundHTML();
  const wish = d.wishlistId ? state.wishlist.find(function (w) { return w.id === d.wishlistId; }) : null;
  const photoBlock = wish ? "" +
    '<div class="compare-row">' +
      '<div class="compare-col"><div class="compare-label">Inspo</div><div class="compare-photo">' +
        (wish.thumbnailUrl ? '<img src="' + esc(wish.thumbnailUrl) + '" alt="">' : "") + "</div></div>" +
      '<div class="compare-col"><div class="compare-label">Actual</div><div class="compare-photo">' +
        (d.photoUrl ? '<img src="' + esc(d.photoUrl) + '" alt="">' : "") + "</div></div>" +
    "</div>"
    : '<div class="detail-photo-wrap">' +
      (d.photoUrl ? '<img class="detail-photo" src="' + esc(d.photoUrl) + '" alt="">' : '<div class="detail-photo-empty">' + cameraGlyphSVG() + "</div>") +
      "</div>";
  const tags = [].concat(
    (d.occasion || []).map(function (o) { return '<span class="tag">' + esc(o) + "</span>"; }),
    d.season ? ['<span class="tag">' + esc(d.season) + "</span>"] : [],
    (d.colors || []).map(function (c) { return '<span class="tag">' + esc(c) + "</span>"; }),
    d.technique ? ['<span class="tag">' + esc(d.technique) + "</span>"] : [],
    d.shape ? ['<span class="tag">' + esc(d.shape) + "</span>"] : []
  ).join("");
  return "" +
    '<div class="detail-topbar"><button class="icon-btn" id="detail-back" aria-label="Back">' + backArrowSVG() + "</button>" +
      '<div style="display:flex;gap:8px;"><button class="icon-btn" id="detail-edit" aria-label="Edit">' + editSVG() + "</button>" +
      '<button class="icon-btn" id="detail-delete" aria-label="Delete">' + trashSVG() + "</button></div></div>" +
    photoBlock +
    '<div class="detail-rating-row">' + ratingIconSVG(d.rating, 30, "detail-rating-icon") +
      '<span class="detail-rating-label">' + esc(ratingLabel(d.rating)) + "</span>" +
      (d.wouldRepeat ? '<span class="tag">Would repeat</span>' : "") + "</div>" +
    '<div class="detail-tags">' + tags + "</div>" +
    (d.location ? '<div class="detail-field"><div class="detail-field-label">Location</div><div class="detail-field-value">' + esc(d.location) + "</div></div>" : "") +
    ((d.artistName || d.artistHandle) ? '<div class="detail-field"><div class="detail-field-label">Nail Artist</div><div class="detail-field-value">' +
      esc(d.artistName || "") + (d.artistHandle ? " · " + esc(d.artistHandle) : "") + "</div></div>" : "") +
    '<div class="detail-field"><div class="detail-field-label">Logged</div><div class="detail-field-value">' + esc(formatDate(d.dateLogged)) + "</div></div>" +
    (d.notes ? '<div class="detail-notes">' + esc(d.notes).replace(/\n/g, "<br>") + "</div>" : "");
}
function bindDesignDetailEvents(id) {
  const d = state.designs.find(function (x) { return x.id === id; });
  if (!d) return;
  document.getElementById("detail-back").addEventListener("click", function () { navigate("#/gallery"); });
  document.getElementById("detail-edit").addEventListener("click", function () { navigate("#/design/" + id + "/edit"); });
  document.getElementById("detail-delete").addEventListener("click", function () {
    if (confirm("Delete this design? This can't be undone.")) { removeDesign(id); navigate("#/gallery"); }
  });
}

/* ── add / edit design ─────────────────────────────────────── */
let formDraft = null;
function makeDefaultDesignDraft() {
  return {
    id: uid(), photoUrl: "", _photoBlob: null, _photoLocalPreview: null,
    dateLogged: todayISO(), occasion: [], season: "", colors: [], technique: "",
    location: "", artistName: "", artistHandle: "", shape: "", rating: "",
    wouldRepeat: false, wishlistId: null, notes: ""
  };
}
function initDesignDraft(existingId, fromWishlistId) {
  if (existingId) {
    const existing = state.designs.find(function (d) { return d.id === existingId; });
    formDraft = existing ? Object.assign(makeDefaultDesignDraft(), JSON.parse(JSON.stringify(existing))) : makeDefaultDesignDraft();
  } else {
    formDraft = makeDefaultDesignDraft();
    if (fromWishlistId) {
      const w = state.wishlist.find(function (x) { return x.id === fromWishlistId; });
      if (w) {
        formDraft.occasion = (w.occasion || []).slice();
        formDraft.season = w.season || "";
        formDraft.colors = (w.colors || []).slice();
        formDraft.wishlistId = w.id;
      }
    }
  }
}
function designFormBodyHTML() {
  const previewSrc = formDraft._photoLocalPreview || formDraft.photoUrl;
  const inspoWish = formDraft.wishlistId ? state.wishlist.find(function (w) { return w.id === formDraft.wishlistId; }) : null;
  return "" +
    (inspoWish ? '<div class="link-preview">Inspired by &ldquo;' + esc(inspoWish.title) + '&rdquo;</div>' : "") +
    '<div class="form-section"><label class="form-label">Photo</label>' +
      '<label class="photo-picker" id="photo-picker">' +
        (previewSrc ? '<img id="photo-preview" src="' + esc(previewSrc) + '" alt="">' : '<span class="photo-picker-hint" id="photo-hint">Tap to take or choose a photo</span>') +
        '<input type="file" accept="image/*" capture="environment" id="photo-input"></label></div>' +
    '<div class="form-section"><label class="form-label">Date</label><input class="form-input" type="date" id="field-date" value="' + esc(formDraft.dateLogged) + '"></div>' +
    '<div class="form-section"><label class="form-label">Rating</label><div class="rating-picker">' +
      RATING_TIERS.map(function (r) {
        return '<div class="rating-option' + (formDraft.rating === r.id ? " active" : "") + '" data-rating="' + r.id + '">' +
          ratingIconSVG(r.id, 28) + '<span class="rating-option-label">' + r.label + "</span></div>";
      }).join("") + "</div></div>" +
    '<div class="form-section"><div class="toggle-row"><span>Would repeat?</span><label class="switch">' +
      '<input type="checkbox" id="field-repeat"' + (formDraft.wouldRepeat ? " checked" : "") + '><span class="switch-track"></span><span class="switch-thumb"></span></label></div></div>' +
    '<div class="form-section"><label class="form-label">Occasion</label><div class="chip-row">' +
      OCCASIONS.map(function (o) { return chipHTML("occasion", o, o, formDraft.occasion.indexOf(o) >= 0, "pink", "design-multi"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Season</label><div class="chip-row">' +
      SEASONS.map(function (s) { return chipHTML("season", s, s, formDraft.season === s, "blue", "design-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Colors</label><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("colors", c, c, formDraft.colors.indexOf(c) >= 0, "sage", "design-multi"); }).join("") +
      '<button type="button" class="chip" id="add-color-btn">+ Other</button></div>' +
      '<div id="add-color-inline" style="display:none;margin-top:8px;gap:8px;"><input class="form-input" id="new-color-input" placeholder="Color name" style="flex:1;">' +
      '<button type="button" class="btn btn-secondary" id="add-color-confirm">Add</button></div></div>' +
    '<div class="form-section"><label class="form-label">Technique</label><div class="chip-row">' +
      TECHNIQUES.map(function (t) { return chipHTML("technique", t, t, formDraft.technique === t, "pink", "design-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Shape <span style="text-transform:none;font-weight:400;">(optional)</span></label><div class="chip-row">' +
      SHAPES.map(function (s) { return chipHTML("shape", s, s, formDraft.shape === s, "blue", "design-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Location</label><input class="form-input" id="field-location" placeholder="Salon or Home" value="' + esc(formDraft.location) + '"></div>' +
    '<div class="form-row"><div class="form-section"><label class="form-label">Nail artist</label><input class="form-input" id="field-artist" placeholder="Optional" value="' + esc(formDraft.artistName) + '"></div>' +
      '<div class="form-section"><label class="form-label">Handle</label><input class="form-input" id="field-handle" placeholder="@handle" value="' + esc(formDraft.artistHandle) + '"></div></div>' +
    '<div class="form-section"><label class="form-label">Notes</label><textarea class="form-textarea" id="field-notes" placeholder="How\'d it go?">' + esc(formDraft.notes) + "</textarea></div>" +
    '<div class="form-actions"><button type="button" class="btn btn-outline" id="form-cancel">Cancel</button><button type="button" class="btn btn-primary" id="form-save">Save</button></div>';
}
function bindDesignFormEvents(existingId) {
  function refresh() {
    document.getElementById("view-root").innerHTML = designFormBodyHTML();
    bindDesignFormEvents(existingId);
  }
  const root = document.getElementById("view-root");
  document.getElementById("photo-input").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;
    downscaleImage(file, 800, 0.6).then(function (blob) {
      formDraft._photoBlob = blob;
      formDraft._photoLocalPreview = URL.createObjectURL(blob);
      refresh();
    }).catch(function () { alert("Could not read that photo — try another."); });
  });
  document.getElementById("field-date").addEventListener("input", function (e) { formDraft.dateLogged = e.target.value; });
  document.getElementById("field-repeat").addEventListener("change", function (e) { formDraft.wouldRepeat = e.target.checked; });
  document.getElementById("field-location").addEventListener("input", function (e) { formDraft.location = e.target.value; });
  document.getElementById("field-artist").addEventListener("input", function (e) { formDraft.artistName = e.target.value; });
  document.getElementById("field-handle").addEventListener("input", function (e) { formDraft.artistHandle = e.target.value; });
  document.getElementById("field-notes").addEventListener("input", function (e) { formDraft.notes = e.target.value; });
  root.querySelectorAll(".rating-option").forEach(function (el) {
    el.addEventListener("click", function () {
      formDraft.rating = formDraft.rating === el.dataset.rating ? "" : el.dataset.rating;
      refresh();
    });
  });
  root.querySelectorAll('[data-chip-mode="design-multi"],[data-chip-mode="design-single"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const mode = btn.dataset.chipMode, group = btn.dataset.chipGroup, value = btn.dataset.chipValue;
      if (mode === "design-multi") {
        const arr = formDraft[group], i = arr.indexOf(value);
        if (i >= 0) arr.splice(i, 1); else arr.push(value);
      } else {
        formDraft[group] = formDraft[group] === value ? "" : value;
      }
      refresh();
    });
  });
  document.getElementById("add-color-btn").addEventListener("click", function () {
    document.getElementById("add-color-inline").style.display = "flex";
    document.getElementById("new-color-input").focus();
  });
  document.getElementById("add-color-confirm").addEventListener("click", function () {
    const val = document.getElementById("new-color-input").value.trim();
    if (!val) return;
    if (allColors().indexOf(val) === -1) { state.customColors.push(val); saveStoreLocal(); }
    if (formDraft.colors.indexOf(val) === -1) formDraft.colors.push(val);
    refresh();
  });
  document.getElementById("form-cancel").addEventListener("click", function () {
    if (formDraft._photoLocalPreview) URL.revokeObjectURL(formDraft._photoLocalPreview);
    const back = existingId ? "#/design/" + existingId : "#/gallery";
    formDraft = null;
    navigate(back);
  });
  document.getElementById("form-save").addEventListener("click", function () {
    const saveBtn = document.getElementById("form-save");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    Promise.resolve(formDraft._photoBlob ? uploadPhoto(formDraft._photoBlob, "design-" + formDraft.id) : formDraft.photoUrl)
      .then(function (photoUrl) {
        const design = {
          id: formDraft.id, photoUrl: photoUrl, dateLogged: formDraft.dateLogged || todayISO(),
          occasion: formDraft.occasion, season: formDraft.season, colors: formDraft.colors,
          technique: formDraft.technique, location: formDraft.location, artistName: formDraft.artistName,
          artistHandle: formDraft.artistHandle, shape: formDraft.shape, rating: formDraft.rating,
          wouldRepeat: !!formDraft.wouldRepeat, wishlistId: formDraft.wishlistId || null, notes: formDraft.notes,
          updatedAt: Date.now()
        };
        const isNew = !existingId;
        upsertDesign(design);
        if (isNew && design.wishlistId) {
          const w = state.wishlist.find(function (x) { return x.id === design.wishlistId; });
          if (w) { w.status = "tried"; w.resultDesignId = design.id; upsertWishlist(w); }
        }
        if (formDraft._photoLocalPreview) URL.revokeObjectURL(formDraft._photoLocalPreview);
        formDraft = null;
        navigate("#/design/" + design.id);
      }).catch(function () {
        alert("Could not save — check your connection and try again.");
        saveBtn.disabled = false; saveBtn.textContent = "Save";
      });
  });
}

/* ── wishlist list ─────────────────────────────────────────── */
function wishlistHTML() {
  const f = state.filters.wishlist;
  return "" +
    '<input id="wishlist-search" class="search-input" type="search" placeholder="Search title or notes…" value="' + esc(f.query) + '">' +
    '<div class="filter-group"><div class="filter-label">Status</div><div class="chip-row">' +
      [["saved", "Saved"], ["tried", "Tried"]].map(function (p) { return chipHTML("status", p[0], p[1], f.status === p[0], "neutral", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Occasion</div><div class="chip-row">' +
      OCCASIONS.map(function (o) { return chipHTML("occasion", o, o, f.occasion === o, "pink", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Season</div><div class="chip-row">' +
      SEASONS.map(function (s) { return chipHTML("season", s, s, f.season === s, "blue", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Color</div><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("color", c, c, f.color === c, "sage", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filters-bar"><span class="result-line" id="wishlist-result-line"></span>' +
      '<button type="button" class="btn-text" id="wishlist-add-link-btn">+ Add via link</button></div>' +
    '<div id="wishlist-list"></div>';
}
function wishCardHTML(w) {
  const thumb = w.thumbnailUrl
    ? '<img class="wish-thumb" src="' + esc(w.thumbnailUrl) + '" alt="">'
    : '<div class="wish-thumb-empty">' + cameraGlyphSVG() + "</div>";
  return '<div class="wish-card" data-open-wish="' + w.id + '">' + thumb +
    '<div class="wish-body"><span class="wish-status ' + (w.status === "tried" ? "wish-status-tried" : "wish-status-saved") + '">' +
      (w.status === "tried" ? "Tried" : "Saved") + "</span>" +
    '<div class="wish-title">' + esc(w.title || "Untitled") + "</div>" +
    '<div class="wish-meta">' + esc(formatDate(w.dateAdded)) + (w.season ? " · " + esc(w.season) : "") + "</div></div></div>";
}
function updateWishlistResults() {
  const f = state.filters.wishlist;
  let list = state.wishlist.filter(function (w) { return matchesFilters(w, f); });
  list = list.slice().sort(function (a, b) { return (b.dateAdded || "").localeCompare(a.dateAdded || ""); });
  document.getElementById("wishlist-result-line").textContent = list.length + (list.length === 1 ? " item" : " items");
  const container = document.getElementById("wishlist-list");
  if (!list.length) {
    const hasAny = state.wishlist.length > 0;
    container.innerHTML = '<div class="empty-state"><div class="empty-title">' + (hasAny ? "No matches" : "Wishlist is empty") +
      '</div><div class="empty-body">' + (hasAny ? "Try clearing a filter." : "Add a design you want to try, with a link for inspiration.") + "</div></div>";
    return;
  }
  container.innerHTML = list.map(wishCardHTML).join("");
}
function bindWishlistEvents() {
  updateWishlistResults();
  const root = document.getElementById("view-root");
  const search = document.getElementById("wishlist-search");
  search.addEventListener("input", debounce(function () {
    state.filters.wishlist.query = search.value;
    updateWishlistResults();
  }, 150));
  root.querySelectorAll('[data-chip-mode="filter-wishlist"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const group = btn.dataset.chipGroup, value = btn.dataset.chipValue;
      const f = state.filters.wishlist;
      f[group] = f[group] === value ? null : value;
      renderRoute();
    });
  });
  document.getElementById("wishlist-add-link-btn").addEventListener("click", function () { navigate("#/wishlist/add"); });
  document.getElementById("wishlist-list").addEventListener("click", function (e) {
    const card = e.target.closest("[data-open-wish]");
    if (card) navigate("#/wishlist/" + card.dataset.openWish);
  });
}

/* ── wishlist detail ───────────────────────────────────────── */
function wishlistDetailHTML(id) {
  const w = state.wishlist.find(function (x) { return x.id === id; });
  if (!w) return notFoundHTML();
  const result = w.resultDesignId ? state.designs.find(function (d) { return d.id === w.resultDesignId; }) : null;
  const tags = [].concat(
    (w.occasion || []).map(function (o) { return '<span class="tag">' + esc(o) + "</span>"; }),
    w.season ? ['<span class="tag">' + esc(w.season) + "</span>"] : [],
    (w.colors || []).map(function (c) { return '<span class="tag">' + esc(c) + "</span>"; })
  ).join("");
  return "" +
    '<div class="detail-topbar"><button class="icon-btn" id="detail-back" aria-label="Back">' + backArrowSVG() + "</button>" +
      '<div style="display:flex;gap:8px;"><button class="icon-btn" id="detail-edit" aria-label="Edit">' + editSVG() + "</button>" +
      '<button class="icon-btn" id="detail-delete" aria-label="Delete">' + trashSVG() + "</button></div></div>" +
    '<div class="detail-photo-wrap">' +
      (w.thumbnailUrl ? '<img class="detail-photo" src="' + esc(w.thumbnailUrl) + '" alt="">' : '<div class="detail-photo-empty">' + cameraGlyphSVG() + "</div>") + "</div>" +
    '<h2 style="font-size:20px;margin-bottom:6px;">' + esc(w.title) + "</h2>" +
    (w.sourceUrl ? '<div class="link-preview"><a href="' + esc(w.sourceUrl) + '" target="_blank" rel="noopener">' + esc(w.sourceUrl) + "</a></div>" : "") +
    '<div class="detail-tags" style="margin-top:12px;"><span class="wish-status ' + (w.status === "tried" ? "wish-status-tried" : "wish-status-saved") + '">' +
      (w.status === "tried" ? "Tried" : "Saved") + "</span>" + tags + "</div>" +
    (w.notes ? '<div class="detail-notes">' + esc(w.notes).replace(/\n/g, "<br>") + "</div>" : "") +
    '<div class="detail-field"><div class="detail-field-label">Added</div><div class="detail-field-value">' + esc(formatDate(w.dateAdded)) + "</div></div>" +
    '<div class="detail-actions">' +
      (w.status === "saved"
        ? '<button class="btn btn-primary" id="mark-tried-btn">Mark as tried</button>'
        : (result ? '<button class="btn btn-secondary" id="view-result-btn">View result</button>' : "")) +
    "</div>";
}
function bindWishlistDetailEvents(id) {
  const w = state.wishlist.find(function (x) { return x.id === id; });
  if (!w) return;
  document.getElementById("detail-back").addEventListener("click", function () { navigate("#/wishlist"); });
  document.getElementById("detail-edit").addEventListener("click", function () { navigate("#/wishlist/" + id + "/edit"); });
  document.getElementById("detail-delete").addEventListener("click", function () {
    if (confirm("Delete this wishlist item?")) { removeWishlist(id); navigate("#/wishlist"); }
  });
  const markBtn = document.getElementById("mark-tried-btn");
  if (markBtn) markBtn.addEventListener("click", function () { navigate("#/design/new/from/" + id); });
  const viewBtn = document.getElementById("view-result-btn");
  if (viewBtn) viewBtn.addEventListener("click", function () {
    const cur = state.wishlist.find(function (x) { return x.id === id; });
    if (cur && cur.resultDesignId) navigate("#/design/" + cur.resultDesignId);
  });
}

/* ── add / edit wishlist item ──────────────────────────────── */
let wishDraft = null;
function makeDefaultWishDraft() {
  return {
    id: uid(), title: "", sourceUrl: "", thumbnailUrl: "", _thumbBlob: null, _thumbLocalPreview: null,
    occasion: [], season: "", colors: [], notes: "", dateAdded: todayISO(), status: "saved", resultDesignId: null
  };
}
function initWishlistDraft(existingId) {
  if (existingId) {
    const existing = state.wishlist.find(function (w) { return w.id === existingId; });
    wishDraft = existing ? Object.assign(makeDefaultWishDraft(), JSON.parse(JSON.stringify(existing))) : makeDefaultWishDraft();
  } else {
    wishDraft = makeDefaultWishDraft();
  }
}
function wishlistFormBodyHTML() {
  const previewSrc = wishDraft._thumbLocalPreview || wishDraft.thumbnailUrl;
  return "" +
    '<div class="form-section"><label class="form-label">Thumbnail</label>' +
      '<label class="photo-picker" id="thumb-picker">' +
        (previewSrc ? '<img id="thumb-preview" src="' + esc(previewSrc) + '" alt="">' : '<span class="photo-picker-hint" id="thumb-hint">Tap to upload an image</span>') +
        '<input type="file" accept="image/*" id="thumb-input"></label>' +
      '<div class="field-hint">Or paste an image URL:</div>' +
      '<input class="form-input" id="field-thumb-url" placeholder="https://…" value="' + (wishDraft._thumbBlob ? "" : esc(wishDraft.thumbnailUrl)) + '" style="margin-top:6px;"></div>' +
    '<div class="form-section"><label class="form-label">Title</label><input class="form-input" id="field-title" placeholder="e.g. Almond French with gold foil" value="' + esc(wishDraft.title) + '"></div>' +
    '<div class="form-section"><label class="form-label">Source link</label><input class="form-input" id="field-source" type="url" placeholder="Pinterest or any link" value="' + esc(wishDraft.sourceUrl) + '"></div>' +
    '<div class="form-section"><label class="form-label">Occasion</label><div class="chip-row">' +
      OCCASIONS.map(function (o) { return chipHTML("occasion", o, o, wishDraft.occasion.indexOf(o) >= 0, "pink", "wish-multi"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Season</label><div class="chip-row">' +
      SEASONS.map(function (s) { return chipHTML("season", s, s, wishDraft.season === s, "blue", "wish-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Colors</label><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("colors", c, c, wishDraft.colors.indexOf(c) >= 0, "sage", "wish-multi"); }).join("") +
      '<button type="button" class="chip" id="wish-add-color-btn">+ Other</button></div>' +
      '<div id="wish-add-color-inline" style="display:none;margin-top:8px;gap:8px;"><input class="form-input" id="wish-new-color-input" placeholder="Color name" style="flex:1;">' +
      '<button type="button" class="btn btn-secondary" id="wish-add-color-confirm">Add</button></div></div>' +
    '<div class="form-section"><label class="form-label">Notes</label><textarea class="form-textarea" id="field-wish-notes" placeholder="What do you love about it?">' + esc(wishDraft.notes) + "</textarea></div>" +
    '<div class="form-actions"><button type="button" class="btn btn-outline" id="wish-form-cancel">Cancel</button><button type="button" class="btn btn-primary" id="wish-form-save">Save</button></div>';
}
function bindWishlistFormEvents(existingId) {
  function refresh() {
    document.getElementById("view-root").innerHTML = wishlistFormBodyHTML();
    bindWishlistFormEvents(existingId);
  }
  const root = document.getElementById("view-root");
  document.getElementById("thumb-input").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;
    downscaleImage(file, 800, 0.6).then(function (blob) {
      wishDraft._thumbBlob = blob;
      wishDraft._thumbLocalPreview = URL.createObjectURL(blob);
      refresh();
    }).catch(function () { alert("Could not read that image — try another."); });
  });
  document.getElementById("field-thumb-url").addEventListener("input", function (e) {
    wishDraft.thumbnailUrl = e.target.value;
    wishDraft._thumbBlob = null;
    wishDraft._thumbLocalPreview = null;
  });
  document.getElementById("field-title").addEventListener("input", function (e) { wishDraft.title = e.target.value; });
  document.getElementById("field-source").addEventListener("input", function (e) { wishDraft.sourceUrl = e.target.value; });
  document.getElementById("field-wish-notes").addEventListener("input", function (e) { wishDraft.notes = e.target.value; });
  root.querySelectorAll('[data-chip-mode="wish-multi"],[data-chip-mode="wish-single"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const mode = btn.dataset.chipMode, group = btn.dataset.chipGroup, value = btn.dataset.chipValue;
      if (mode === "wish-multi") {
        const arr = wishDraft[group], i = arr.indexOf(value);
        if (i >= 0) arr.splice(i, 1); else arr.push(value);
      } else {
        wishDraft[group] = wishDraft[group] === value ? "" : value;
      }
      refresh();
    });
  });
  document.getElementById("wish-add-color-btn").addEventListener("click", function () {
    document.getElementById("wish-add-color-inline").style.display = "flex";
    document.getElementById("wish-new-color-input").focus();
  });
  document.getElementById("wish-add-color-confirm").addEventListener("click", function () {
    const val = document.getElementById("wish-new-color-input").value.trim();
    if (!val) return;
    if (allColors().indexOf(val) === -1) { state.customColors.push(val); saveStoreLocal(); }
    if (wishDraft.colors.indexOf(val) === -1) wishDraft.colors.push(val);
    refresh();
  });
  document.getElementById("wish-form-cancel").addEventListener("click", function () {
    if (wishDraft._thumbLocalPreview) URL.revokeObjectURL(wishDraft._thumbLocalPreview);
    const back = existingId ? "#/wishlist/" + existingId : "#/wishlist";
    wishDraft = null;
    navigate(back);
  });
  document.getElementById("wish-form-save").addEventListener("click", function () {
    const title = (wishDraft.title || "").trim();
    if (!title) { alert("Give it a title first."); return; }
    const saveBtn = document.getElementById("wish-form-save");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    Promise.resolve(wishDraft._thumbBlob ? uploadPhoto(wishDraft._thumbBlob, "wishlist-" + wishDraft.id) : wishDraft.thumbnailUrl)
      .then(function (thumbnailUrl) {
        const item = {
          id: wishDraft.id, title: title, sourceUrl: wishDraft.sourceUrl || "", thumbnailUrl: thumbnailUrl || "",
          occasion: wishDraft.occasion, season: wishDraft.season, colors: wishDraft.colors,
          notes: wishDraft.notes, dateAdded: wishDraft.dateAdded || todayISO(), status: wishDraft.status || "saved",
          resultDesignId: wishDraft.resultDesignId || null, updatedAt: Date.now()
        };
        upsertWishlist(item);
        if (wishDraft._thumbLocalPreview) URL.revokeObjectURL(wishDraft._thumbLocalPreview);
        wishDraft = null;
        navigate("#/wishlist/" + item.id);
      }).catch(function () {
        alert("Could not save — check your connection and try again.");
        saveBtn.disabled = false; saveBtn.textContent = "Save";
      });
  });
}

/* ── lock screen ───────────────────────────────────────────── */
function showApp() {
  document.getElementById("lock-screen").hidden = true;
  document.getElementById("app").hidden = false;
}
function showLock() {
  document.getElementById("lock-screen").hidden = false;
  document.getElementById("app").hidden = true;
}
function submitPasscode() {
  const input = document.getElementById("lock-input");
  const code = input.value.trim();
  const errEl = document.getElementById("lock-error");
  if (!code) { errEl.hidden = false; errEl.textContent = "Enter the passcode."; return; }
  errEl.hidden = true;
  hashPasscode(code).then(function (hash) {
    try { window.localStorage.setItem(CLOUD_KEY, hash); } catch (e) {}
    savedHash = hash;
    input.value = "";
    showApp();
    connectCloud(hash);
    renderRoute();
  }).catch(function () {
    errEl.hidden = false; errEl.textContent = "Couldn't unlock on this device — try again.";
  });
}
function lockAgain() {
  if (unsubDesigns) unsubDesigns();
  if (unsubWishlist) unsubWishlist();
  try { window.localStorage.removeItem(CLOUD_KEY); } catch (e) {}
  location.reload();
}

/* ── boot ──────────────────────────────────────────────────── */
function wireStaticUI() {
  document.getElementById("lock-submit").addEventListener("click", submitPasscode);
  document.getElementById("lock-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPasscode();
  });
  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const target = btn.dataset.nav;
      navigate(target === "add" ? "#/design/new" : "#/" + target);
    });
  });
  const lockBtn = document.getElementById("lock-again-btn");
  if (lockBtn) {
    lockBtn.hidden = !(FIREBASE_ENABLED && REQUIRE_PASSCODE);
    lockBtn.addEventListener("click", lockAgain);
  }
  window.addEventListener("hashchange", function () {
    renderRoute();
    window.scrollTo(0, 0);
  });
}
function boot() {
  wireStaticUI();
  if (unlocked) {
    showApp();
    if (FIREBASE_ENABLED) {
      connectCloud(REQUIRE_PASSCODE && savedHash ? savedHash : DEFAULT_CLOUD_DOC);
    }
    renderRoute();
  } else {
    showLock();
  }
}
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  });
}
boot();
