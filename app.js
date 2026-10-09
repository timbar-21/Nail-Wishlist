"use strict";

/* ── config ────────────────────────────────────────────────── */
const STORAGE_KEY = "krista-nail-journal-v1";
const CLOUD_KEY = "krista-nail-journal-cloud-hash";
const SALON_SEARCH_KEY = "krista-nail-journal-salon-search";

/* Cross-device sync via Firebase Firestore, set up once in a NEW Firebase
   project (console.firebase.google.com, free Spark tier — no billing
   required) — kept separate from any other app's project. Fill in the
   real values below and re-deploy to turn syncing on; until then
   FIREBASE_ENABLED stays false and the app runs local-only. This config
   is meant to be public (that's how Firebase client config works); real
   access control lives in firestore.rules, which restricts every read/
   write to paths keyed by the passcode's SHA-256 hash below — the
   passcode itself never leaves the device, only its hash does. See
   README.md for setup steps, and double-check the deployed rules in the
   Firebase console — they can't be verified from this client code alone.

   Photos are embedded as compressed base64 data: URLs directly in the
   Firestore document (not Firebase Storage) — Cloud Storage now requires
   the pay-as-you-go Blaze plan even at zero usage, and this keeps the
   whole app on Firestore's free Spark tier. Compression retries at
   progressively smaller sizes if needed to stay well under Firestore's
   1MiB-per-document limit. */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCVtClz9XCob6rNXj80os2dNBNPRAczz-s",
  authDomain: "nail-journal.firebaseapp.com",
  projectId: "nail-journal",
  storageBucket: "nail-journal.firebasestorage.app",
  messagingSenderId: "496873883667",
  appId: "1:496873883667:web:a529b5db06e2dda73fd7e6"
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
const SALON_STATUSES = [
  { id: "want", label: "Want to try" },
  { id: "tried", label: "Tried" },
  { id: "favorite", label: "Favorite" }
];
/* How each technique reads as a Google Maps search term. Press-ons are
   deliberately absent — they're not something to find a salon for. */
const TECHNIQUE_SEARCH_TERMS = {
  "Gel": "gel manicure",
  "Acrylic": "acrylic nails",
  "Dip Powder": "dip powder nails",
  "Regular Polish": "manicure"
};
/* Styles aren't a tagged field, so they're picked out of design notes and
   wishlist titles/notes by keyword. */
const NAIL_STYLES = [
  { id: "Nail Art", term: "nail art", pattern: /nail art|hand[- ]?paint|\b3d\b|charms?\b|floral|flowers?|abstract|swirl|foil|gold leaf|gems?\b|rhinestone/i },
  { id: "Chrome", term: "chrome nails", pattern: /chrome|glazed|pearl/i },
  { id: "French", term: "french manicure", pattern: /french/i },
  { id: "Cat Eye", term: "cat eye nails", pattern: /cat[- ]?eye|velvet/i },
  { id: "Ombré", term: "ombre nails", pattern: /ombr[eé]|baby boomer|gradient/i },
  { id: "Aura", term: "aura nails", pattern: /\baura|airbrush/i },
  { id: "Extensions", term: "gel-x extensions", pattern: /gel[- ]?x|extensions?\b|builder gel|biab/i }
];
const RATING_WEIGHTS = { love: 3, like: 2, meh: 0.5, skip: -1 };

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
      salons: s.salons || [],
      customColors: s.customColors || []
    };
  } catch (e) {
    return { designs: [], wishlist: [], salons: [], customColors: [] };
  }
}
function saveStoreLocal() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      designs: state.designs, wishlist: state.wishlist, salons: state.salons, customColors: state.customColors
    }));
  } catch (e) {}
}

/* Salon-search criteria are a per-device convenience (home neighborhood,
   last-used chips), so they live in their own key and never sync.
   `selected` stays null until the first chip tap, meaning "use whatever
   the nail profile suggests" — so the defaults keep tracking new designs
   until she actually customizes them. */
function loadSalonSearch() {
  let s = {};
  try { s = JSON.parse(window.localStorage.getItem(SALON_SEARCH_KEY)) || {}; } catch (e) {}
  return Object.assign({ near: "home", home: "", other: "", selected: null, extras: "", openNow: false }, s);
}
function saveSalonSearch() {
  try { window.localStorage.setItem(SALON_SEARCH_KEY, JSON.stringify(state.salonSearch)); } catch (e) {}
}

const state = Object.assign({
  filters: {
    gallery: { query: "", occasion: null, season: [], color: null, rating: null, sort: "date" },
    wishlist: { query: "", occasion: null, season: [], color: null, status: null }
  },
  salonSearch: loadSalonSearch(),
  syncStatus: ""
}, loadStore());

/* Seasons are multi-select, and older saved records may still have a
   single string from before that was true — accept either shape. */
function seasonArray(item) {
  const s = item && item.season;
  if (Array.isArray(s)) return s;
  if (s) return [s];
  return [];
}

function allColors() {
  return DEFAULT_COLORS.concat(state.customColors.filter(function (c) { return DEFAULT_COLORS.indexOf(c) === -1; }));
}

/* ── passcode / lock state ─────────────────────────────────── */
let savedHash = null;
try { savedHash = window.localStorage.getItem(CLOUD_KEY); } catch (e) {}
let unlocked = !FIREBASE_ENABLED || !REQUIRE_PASSCODE || (REQUIRE_PASSCODE && !!savedHash);

/* ── Firebase (Firestore only) ─────────────────────────────────
   One parent doc per passcode hash holds two subcollections — designs
   and wishlist — so each item is its own document (not one big blob),
   letting devices merge independent additions/edits without clobbering
   each other. Photos are embedded as base64 data: URLs on the document
   itself (see compressPhotoToDataURL below) rather than living in
   Firebase Storage, which would require the paid Blaze plan. */
let db = null, designsColRef = null, wishlistColRef = null, salonsColRef = null;
let unsubDesigns = null, unsubWishlist = null, unsubSalons = null, firebaseLoading = null, passcodeHash = null;

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
    const parent = db.collection("passcodes").doc(hash);
    designsColRef = parent.collection("designs");
    wishlistColRef = parent.collection("wishlist");
    connectSalons(parent);
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

/* Salons sync on their own chain so a project whose deployed rules
   predate the salons subcollection keeps syncing designs and wishlist —
   saved salons just stay on this device until the rules are updated. */
function connectSalons(parent) {
  const colRef = parent.collection("salons");
  colRef.get().then(function (snap) {
    const remoteIds = new Set(snap.docs.map(function (d) { return d.id; }));
    const localOnly = state.salons.filter(function (x) { return !remoteIds.has(x.id); });
    state.salons = mergeById(snap.docs.map(function (d) { return d.data(); }), localOnly);
    saveStoreLocal();
    refreshDataViews();
    salonsColRef = colRef;
    unsubSalons = listenToCollection(salonsColRef, "salons");
    return Promise.all(localOnly.map(function (x) { return salonsColRef.doc(x.id).set(x); }));
  }).catch(function () {});
}

function listenToCollection(colRef, key) {
  return colRef.onSnapshot(function (snap) {
    if (snap.metadata.hasPendingWrites) return;
    snap.docChanges().forEach(function (change) {
      if (change.type === "removed") {
        state[key] = state[key].filter(function (x) { return x.id !== change.doc.id; });
      } else {
        const data = change.doc.data();
        const idx = state[key].findIndex(function (x) { return x.id === data.id; });
        if (idx >= 0) state[key][idx] = data; else state[key].unshift(data);
      }
    });
    saveStoreLocal();
    refreshDataViews();
    setSyncStatus("Synced");
  }, function () {
    setSyncStatus("Offline — saved on this device, will sync when reconnected.");
  });
}

function subscribeCloud() {
  unsubDesigns = listenToCollection(designsColRef, "designs");
  unsubWishlist = listenToCollection(wishlistColRef, "wishlist");
}

/* Compresses straight from the original file (not a re-encode of an
   already-compressed preview, which would waste quality-per-byte) and
   keeps shrinking until the base64 result comfortably fits inside
   Firestore's 1MiB-per-document limit alongside the rest of the doc's
   fields. Ordinary phone photos land in the first pass; this is a
   safety net for the unusually detailed ones. */
function compressPhotoToDataURL(file) {
  const attempts = [[800, 0.6], [640, 0.5], [480, 0.4], [360, 0.35]];
  const maxChars = 700000;
  function tryAt(i) {
    const step = attempts[i];
    return downscaleImage(file, step[0], step[1]).then(function (blob) {
      return blobToDataURL(blob).then(function (dataUrl) {
        if (dataUrl.length <= maxChars || i === attempts.length - 1) return dataUrl;
        return tryAt(i + 1);
      });
    });
  }
  return tryAt(0);
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
function upsertSalon(salon) {
  const idx = state.salons.findIndex(function (x) { return x.id === salon.id; });
  if (idx >= 0) state.salons[idx] = salon; else state.salons.unshift(salon);
  saveStoreLocal();
  refreshDataViews();
  if (salonsColRef) salonsColRef.doc(salon.id).set(salon).catch(function () {});
}
function removeSalon(id) {
  state.salons = state.salons.filter(function (x) { return x.id !== id; });
  saveStoreLocal();
  refreshDataViews();
  if (salonsColRef) salonsColRef.doc(id).delete().catch(function () {});
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
function chevronLeftSVG() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>'; }
function pinSVG() { return '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg>'; }
function chevronRightSVG() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg>'; }

/* ── swipe gesture ─────────────────────────────────────────── */
/* Pointer Events cover touch + mouse with one code path. Axis is locked
   on the first meaningful move so a mostly-vertical drag falls through
   to native page scroll untouched (we never call preventDefault — CSS
   touch-action:pan-y on the card does the work of telling the browser
   vertical panning is still its job). Only horizontal drags animate the
   card and can trigger a swipe. */
function attachSwipe(el, handlers) {
  let startX = 0, startY = 0, curX = 0, curY = 0, dragging = false, axis = null, pointerId = null;
  const threshold = 70;
  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = curX = e.clientX; startY = curY = e.clientY;
    dragging = true; axis = null;
    /* Deliberately no setPointerCapture here: the swipe wrapper contains
       ordinary buttons (edit/delete/back/chevrons), and capturing would
       redirect their pointerup — and the click it synthesizes — to this
       element instead of the button, silently breaking every tap. Plain
       bubbling is enough since the wrapper spans the whole view. */
  }
  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    curX = e.clientX; curY = e.clientY;
    const dx = curX - startX, dy = curY - startY;
    if (!axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (axis === "x" && handlers.onDragX) handlers.onDragX(dx);
  }
  function onUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    const dx = curX - startX;
    if (axis === "x") {
      if (dx <= -threshold && handlers.onSwipeLeft) handlers.onSwipeLeft();
      else if (dx >= threshold && handlers.onSwipeRight) handlers.onSwipeRight();
      else if (handlers.onCancelX) handlers.onCancelX();
    }
    axis = null;
  }
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}
function snapBack(el) {
  el.style.transition = "transform 200ms ease";
  el.style.transform = "";
}
function animateSwipeOut(el, dir, done) {
  el.style.transition = "transform 160ms ease, opacity 160ms ease";
  el.style.transform = "translateX(" + (dir === "left" ? "-36px" : "36px") + ")";
  el.style.opacity = "0.15";
  setTimeout(done, 150);
}

/* Keyboard left/right/escape while a detail view is mounted — replaced
   wholesale on every navigation so stale handlers never stack up. */
let activeKeyNavHandler = null;
function clearDetailKeyNav() {
  if (activeKeyNavHandler) { document.removeEventListener("keydown", activeKeyNavHandler); activeKeyNavHandler = null; }
}
function bindDetailKeyNav(kind, backHash, prevId, nextId) {
  clearDetailKeyNav();
  activeKeyNavHandler = function (e) {
    if (e.key === "ArrowLeft" && prevId) navigate("#/" + kind + "/" + prevId);
    else if (e.key === "ArrowRight" && nextId) navigate("#/" + kind + "/" + nextId);
    else if (e.key === "Escape") navigate(backHash);
  };
  document.addEventListener("keydown", activeKeyNavHandler);
}

/* ── toast + confirm sheet (replace alert()/confirm()) ────────── */
function showToast(message, opts) {
  opts = opts || {};
  const el = document.createElement("div");
  el.className = "toast" + (opts.error ? " toast-error" : "");
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(function () { el.classList.add("show"); });
  setTimeout(function () {
    el.classList.remove("show");
    setTimeout(function () { el.remove(); }, 250);
  }, opts.duration || 2200);
}
function showConfirmSheet(message, confirmLabel, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML =
    '<div class="sheet-card"><div class="sheet-message">' + esc(message) + "</div>" +
    '<button type="button" class="btn btn-danger btn-block" id="sheet-confirm">' + esc(confirmLabel) + "</button>" +
    '<button type="button" class="btn btn-outline btn-block" id="sheet-cancel" style="margin-top:8px;">Cancel</button></div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(function () { overlay.classList.add("open"); });
  function close() { overlay.classList.remove("open"); setTimeout(function () { overlay.remove(); }, 220); }
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  overlay.querySelector("#sheet-cancel").addEventListener("click", close);
  overlay.querySelector("#sheet-confirm").addEventListener("click", function () { close(); onConfirm(); });
}
function shakeField(el) {
  el.classList.remove("field-shake");
  void el.offsetWidth;
  el.classList.add("field-shake");
}

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
  if (f.season && f.season.length) {
    const itemSeasons = seasonArray(item);
    if (!f.season.some(function (s) { return itemSeasons.indexOf(s) >= 0; })) return false;
  }
  if (f.color && (item.colors || []).indexOf(f.color) === -1) return false;
  if (f.rating && item.rating !== f.rating) return false;
  if (f.status && item.status !== f.status) return false;
  return true;
}
/* Every filter chip group is single-select except season, which toggles
   membership in an array instead of swapping a lone scalar. */
function toggleFilterValue(f, group, value) {
  if (group === "season") {
    const i = f.season.indexOf(value);
    if (i >= 0) f.season.splice(i, 1); else f.season.push(value);
  } else {
    f[group] = f[group] === value ? null : value;
  }
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
/* Same ordering the grid is currently showing, so swiping through a
   detail view walks the list in the order it was opened from. */
function getGalleryOrderedList() {
  const f = state.filters.gallery;
  return sortDesigns(state.designs.filter(function (d) { return matchesFilters(d, f); }), f.sort);
}
function getWishlistOrderedList() {
  const f = state.filters.wishlist;
  return state.wishlist.filter(function (w) { return matchesFilters(w, f); })
    .slice().sort(function (a, b) { return (b.dateAdded || "").localeCompare(a.dateAdded || ""); });
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
  const tab = (name === "wishlist" || name === "salons") ? name : (name === "design" && parts[1] === "new") ? "add" : "gallery";
  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.nav === tab);
  });
}
function renderRoute() {
  const r = parseRoute(), name = r.name, parts = r.parts;
  updateNavActive(name, parts);
  clearDetailKeyNav();
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
  } else if (name === "salons" && parts[1] === "add") {
    title.textContent = "Add Salon";
    initSalonDraft(null);
    root.innerHTML = salonFormBodyHTML();
    bindSalonFormEvents(null);
  } else if (name === "salons" && parts[1] && parts[2] === "edit") {
    title.textContent = "Edit Salon";
    initSalonDraft(parts[1]);
    root.innerHTML = salonFormBodyHTML();
    bindSalonFormEvents(parts[1]);
  } else if (name === "salons" && parts[1]) {
    title.textContent = "Salon";
    root.innerHTML = salonDetailHTML(parts[1]);
    bindSalonDetailEvents(parts[1]);
  } else if (name === "salons") {
    title.textContent = "Salons";
    root.innerHTML = salonsHTML();
    bindSalonsEvents();
  } else if (name === "design" && parts[1] === "new") {
    const fromWishlistId = parts[2] === "from" ? parts[3] : null;
    const atSalonId = parts[2] === "at" ? parts[3] : null;
    title.textContent = "Add Design";
    initDesignDraft(null, fromWishlistId, atSalonId);
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
  else if (r.name === "salons" && !r.parts[1] && document.getElementById("salon-list")) updateSalonList();
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
      SEASONS.map(function (s) { return chipHTML("season", s, s, f.season.indexOf(s) >= 0, "blue", "filter-gallery"); }).join("") + "</div></div>" +
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
    ? '<img class="card-photo fade-img" src="' + esc(d.photoUrl) + '" loading="lazy" alt="">'
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
      toggleFilterValue(state.filters.gallery, group, value);
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
  const list = getGalleryOrderedList();
  const idx = list.findIndex(function (x) { return x.id === id; });
  const prevId = idx > 0 ? list[idx - 1].id : null;
  const nextId = (idx >= 0 && idx < list.length - 1) ? list[idx + 1].id : null;
  const wish = d.wishlistId ? state.wishlist.find(function (w) { return w.id === d.wishlistId; }) : null;
  const photoBlock = wish ? "" +
    '<div class="compare-row">' +
      '<div class="compare-col"><div class="compare-label">Inspo</div><div class="compare-photo">' +
        (wish.thumbnailUrl ? '<img class="fade-img" src="' + esc(wish.thumbnailUrl) + '" alt="" draggable="false">' : "") + "</div></div>" +
      '<div class="compare-col"><div class="compare-label">Actual</div><div class="compare-photo">' +
        (d.photoUrl ? '<img class="fade-img" src="' + esc(d.photoUrl) + '" alt="" draggable="false">' : "") + "</div></div>" +
    "</div>"
    : '<div class="detail-photo-wrap">' +
      (d.photoUrl ? '<img class="detail-photo fade-img" src="' + esc(d.photoUrl) + '" alt="" draggable="false">' : '<div class="detail-photo-empty">' + cameraGlyphSVG() + "</div>") +
      "</div>";
  const tags = [].concat(
    (d.occasion || []).map(function (o) { return '<span class="tag">' + esc(o) + "</span>"; }),
    seasonArray(d).map(function (s) { return '<span class="tag">' + esc(s) + "</span>"; }),
    (d.colors || []).map(function (c) { return '<span class="tag">' + esc(c) + "</span>"; }),
    d.technique ? ['<span class="tag">' + esc(d.technique) + "</span>"] : [],
    d.shape ? ['<span class="tag">' + esc(d.shape) + "</span>"] : []
  ).join("");
  const centerNav = list.length > 1 ? "" +
    '<div class="detail-topbar-center">' +
      (prevId ? '<button class="icon-btn icon-btn-sm" id="detail-prev" aria-label="Previous design">' + chevronLeftSVG() + "</button>" : '<span class="icon-btn-spacer"></span>') +
      '<span class="swipe-position">' + (idx + 1) + " / " + list.length + "</span>" +
      (nextId ? '<button class="icon-btn icon-btn-sm" id="detail-next" aria-label="Next design">' + chevronRightSVG() + "</button>" : '<span class="icon-btn-spacer"></span>') +
    "</div>" : "<div></div>";
  return '<div class="swipe-card" id="swipe-card">' +
    '<div class="detail-topbar"><button class="icon-btn" id="detail-back" aria-label="Back">' + backArrowSVG() + "</button>" +
      centerNav +
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
    (d.notes ? '<div class="detail-notes">' + esc(d.notes).replace(/\n/g, "<br>") + "</div>" : "") +
    "</div>";
}
function bindDesignDetailEvents(id) {
  const d = state.designs.find(function (x) { return x.id === id; });
  if (!d) return;
  const list = getGalleryOrderedList();
  const idx = list.findIndex(function (x) { return x.id === id; });
  const prevId = idx > 0 ? list[idx - 1].id : null;
  const nextId = (idx >= 0 && idx < list.length - 1) ? list[idx + 1].id : null;

  document.getElementById("detail-back").addEventListener("click", function () { navigate("#/gallery"); });
  document.getElementById("detail-edit").addEventListener("click", function () { navigate("#/design/" + id + "/edit"); });
  document.getElementById("detail-delete").addEventListener("click", function () {
    showConfirmSheet("Delete this design? This can't be undone.", "Delete", function () {
      removeDesign(id);
      navigate("#/gallery");
      showToast("Design deleted");
    });
  });
  const prevBtn = document.getElementById("detail-prev");
  if (prevBtn) prevBtn.addEventListener("click", function () { navigate("#/design/" + prevId); });
  const nextBtn = document.getElementById("detail-next");
  if (nextBtn) nextBtn.addEventListener("click", function () { navigate("#/design/" + nextId); });

  const card = document.getElementById("swipe-card");
  attachSwipe(card, {
    onDragX: function (dx) {
      const resisted = ((dx < 0 && !nextId) || (dx > 0 && !prevId)) ? dx / 4 : dx;
      card.style.transition = "none";
      card.style.transform = "translateX(" + resisted + "px)";
    },
    onSwipeLeft: function () {
      if (nextId) animateSwipeOut(card, "left", function () { navigate("#/design/" + nextId); });
      else snapBack(card);
    },
    onSwipeRight: function () {
      if (prevId) animateSwipeOut(card, "right", function () { navigate("#/design/" + prevId); });
      else snapBack(card);
    },
    onCancelX: function () { snapBack(card); }
  });
  bindDetailKeyNav("design", "#/gallery", prevId, nextId);
}

/* ── add / edit design ─────────────────────────────────────── */
let formDraft = null;
function makeDefaultDesignDraft() {
  return {
    id: uid(), photoUrl: "", _photoFile: null, _photoLocalPreview: null,
    dateLogged: todayISO(), occasion: [], season: [], colors: [], technique: "",
    location: "", artistName: "", artistHandle: "", shape: "", rating: "",
    wouldRepeat: false, wishlistId: null, notes: ""
  };
}
function initDesignDraft(existingId, fromWishlistId, atSalonId) {
  if (existingId) {
    const existing = state.designs.find(function (d) { return d.id === existingId; });
    formDraft = existing ? Object.assign(makeDefaultDesignDraft(), JSON.parse(JSON.stringify(existing))) : makeDefaultDesignDraft();
    formDraft.season = seasonArray(formDraft);
  } else {
    formDraft = makeDefaultDesignDraft();
    if (fromWishlistId) {
      const w = state.wishlist.find(function (x) { return x.id === fromWishlistId; });
      if (w) {
        formDraft.occasion = (w.occasion || []).slice();
        formDraft.season = seasonArray(w);
        formDraft.colors = (w.colors || []).slice();
        formDraft.wishlistId = w.id;
      }
    }
    if (atSalonId) {
      const salon = state.salons.find(function (x) { return x.id === atSalonId; });
      if (salon) formDraft.location = salon.name;
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
        '<input type="file" accept="image/*" id="photo-input"></label></div>' +
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
      SEASONS.map(function (s) { return chipHTML("season", s, s, formDraft.season.indexOf(s) >= 0, "blue", "design-multi"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Colors</label><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("colors", c, c, formDraft.colors.indexOf(c) >= 0, "sage", "design-multi"); }).join("") +
      '<button type="button" class="chip" id="add-color-btn">+ Other</button></div>' +
      '<div id="add-color-inline" style="display:none;margin-top:8px;gap:8px;"><input class="form-input" id="new-color-input" placeholder="Color name" style="flex:1;">' +
      '<button type="button" class="btn btn-secondary" id="add-color-confirm">Add</button></div></div>' +
    '<div class="form-section"><label class="form-label">Technique</label><div class="chip-row">' +
      TECHNIQUES.map(function (t) { return chipHTML("technique", t, t, formDraft.technique === t, "pink", "design-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Shape <span style="text-transform:none;font-weight:400;">(optional)</span></label><div class="chip-row">' +
      SHAPES.map(function (s) { return chipHTML("shape", s, s, formDraft.shape === s, "blue", "design-single"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Location</label><input class="form-input" id="field-location" list="salon-name-options" autocomplete="off" placeholder="Salon or Home" value="' + esc(formDraft.location) + '">' +
      '<datalist id="salon-name-options">' + state.salons.map(function (x) { return '<option value="' + esc(x.name) + '">'; }).join("") + "</datalist></div>" +
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
      formDraft._photoFile = file;
      formDraft._photoLocalPreview = URL.createObjectURL(blob);
      refresh();
    }).catch(function () { showToast("Could not read that photo — try another.", { error: true }); });
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
    Promise.resolve(formDraft._photoFile ? compressPhotoToDataURL(formDraft._photoFile) : formDraft.photoUrl)
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
        markSalonTried(design.location);
        if (isNew && design.wishlistId) {
          const w = state.wishlist.find(function (x) { return x.id === design.wishlistId; });
          if (w) { w.status = "tried"; w.resultDesignId = design.id; upsertWishlist(w); }
        }
        if (formDraft._photoLocalPreview) URL.revokeObjectURL(formDraft._photoLocalPreview);
        formDraft = null;
        navigate("#/design/" + design.id);
        showToast(isNew ? "Added to your gallery" : "Design updated");
      }).catch(function () {
        showToast("Could not save — check your connection and try again.", { error: true });
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
      SEASONS.map(function (s) { return chipHTML("season", s, s, f.season.indexOf(s) >= 0, "blue", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filter-group"><div class="filter-label">Color</div><div class="chip-row">' +
      allColors().map(function (c) { return chipHTML("color", c, c, f.color === c, "sage", "filter-wishlist"); }).join("") + "</div></div>" +
    '<div class="filters-bar"><span class="result-line" id="wishlist-result-line"></span>' +
      '<button type="button" class="btn-text" id="wishlist-add-link-btn">+ Add via link</button></div>' +
    '<div id="wishlist-list"></div>';
}
function wishCardHTML(w) {
  const thumb = w.thumbnailUrl
    ? '<img class="wish-thumb fade-img" src="' + esc(w.thumbnailUrl) + '" loading="lazy" alt="">'
    : '<div class="wish-thumb-empty">' + cameraGlyphSVG() + "</div>";
  return '<div class="wish-card" data-open-wish="' + w.id + '">' + thumb +
    '<div class="wish-body"><span class="wish-status ' + (w.status === "tried" ? "wish-status-tried" : "wish-status-saved") + '">' +
      (w.status === "tried" ? "Tried" : "Saved") + "</span>" +
    '<div class="wish-title">' + esc(w.title || "Untitled") + "</div>" +
    '<div class="wish-meta">' + esc(formatDate(w.dateAdded)) + (seasonArray(w).length ? " · " + esc(seasonArray(w).join(", ")) : "") + "</div></div></div>";
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
      toggleFilterValue(state.filters.wishlist, group, value);
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
  const list = getWishlistOrderedList();
  const idx = list.findIndex(function (x) { return x.id === id; });
  const prevId = idx > 0 ? list[idx - 1].id : null;
  const nextId = (idx >= 0 && idx < list.length - 1) ? list[idx + 1].id : null;
  const result = w.resultDesignId ? state.designs.find(function (d) { return d.id === w.resultDesignId; }) : null;
  const tags = [].concat(
    (w.occasion || []).map(function (o) { return '<span class="tag">' + esc(o) + "</span>"; }),
    seasonArray(w).map(function (s) { return '<span class="tag">' + esc(s) + "</span>"; }),
    (w.colors || []).map(function (c) { return '<span class="tag">' + esc(c) + "</span>"; })
  ).join("");
  const centerNav = list.length > 1 ? "" +
    '<div class="detail-topbar-center">' +
      (prevId ? '<button class="icon-btn icon-btn-sm" id="detail-prev" aria-label="Previous item">' + chevronLeftSVG() + "</button>" : '<span class="icon-btn-spacer"></span>') +
      '<span class="swipe-position">' + (idx + 1) + " / " + list.length + "</span>" +
      (nextId ? '<button class="icon-btn icon-btn-sm" id="detail-next" aria-label="Next item">' + chevronRightSVG() + "</button>" : '<span class="icon-btn-spacer"></span>') +
    "</div>" : "<div></div>";
  return '<div class="swipe-card" id="swipe-card">' +
    '<div class="detail-topbar"><button class="icon-btn" id="detail-back" aria-label="Back">' + backArrowSVG() + "</button>" +
      centerNav +
      '<div style="display:flex;gap:8px;"><button class="icon-btn" id="detail-edit" aria-label="Edit">' + editSVG() + "</button>" +
      '<button class="icon-btn" id="detail-delete" aria-label="Delete">' + trashSVG() + "</button></div></div>" +
    '<div class="detail-photo-wrap">' +
      (w.thumbnailUrl ? '<img class="detail-photo fade-img" src="' + esc(w.thumbnailUrl) + '" alt="" draggable="false">' : '<div class="detail-photo-empty">' + cameraGlyphSVG() + "</div>") + "</div>" +
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
    "</div></div>";
}
function bindWishlistDetailEvents(id) {
  const w = state.wishlist.find(function (x) { return x.id === id; });
  if (!w) return;
  const list = getWishlistOrderedList();
  const idx = list.findIndex(function (x) { return x.id === id; });
  const prevId = idx > 0 ? list[idx - 1].id : null;
  const nextId = (idx >= 0 && idx < list.length - 1) ? list[idx + 1].id : null;

  document.getElementById("detail-back").addEventListener("click", function () { navigate("#/wishlist"); });
  document.getElementById("detail-edit").addEventListener("click", function () { navigate("#/wishlist/" + id + "/edit"); });
  document.getElementById("detail-delete").addEventListener("click", function () {
    showConfirmSheet("Delete this wishlist item?", "Delete", function () {
      removeWishlist(id);
      navigate("#/wishlist");
      showToast("Wishlist item deleted");
    });
  });
  const markBtn = document.getElementById("mark-tried-btn");
  if (markBtn) markBtn.addEventListener("click", function () { navigate("#/design/new/from/" + id); });
  const viewBtn = document.getElementById("view-result-btn");
  if (viewBtn) viewBtn.addEventListener("click", function () {
    const cur = state.wishlist.find(function (x) { return x.id === id; });
    if (cur && cur.resultDesignId) navigate("#/design/" + cur.resultDesignId);
  });
  const prevBtn = document.getElementById("detail-prev");
  if (prevBtn) prevBtn.addEventListener("click", function () { navigate("#/wishlist/" + prevId); });
  const nextBtn = document.getElementById("detail-next");
  if (nextBtn) nextBtn.addEventListener("click", function () { navigate("#/wishlist/" + nextId); });

  const card = document.getElementById("swipe-card");
  attachSwipe(card, {
    onDragX: function (dx) {
      const resisted = ((dx < 0 && !nextId) || (dx > 0 && !prevId)) ? dx / 4 : dx;
      card.style.transition = "none";
      card.style.transform = "translateX(" + resisted + "px)";
    },
    onSwipeLeft: function () {
      if (nextId) animateSwipeOut(card, "left", function () { navigate("#/wishlist/" + nextId); });
      else snapBack(card);
    },
    onSwipeRight: function () {
      if (prevId) animateSwipeOut(card, "right", function () { navigate("#/wishlist/" + prevId); });
      else snapBack(card);
    },
    onCancelX: function () { snapBack(card); }
  });
  bindDetailKeyNav("wishlist", "#/wishlist", prevId, nextId);
}

/* ── add / edit wishlist item ──────────────────────────────── */
let wishDraft = null;
function makeDefaultWishDraft() {
  return {
    id: uid(), title: "", sourceUrl: "", thumbnailUrl: "", _thumbFile: null, _thumbLocalPreview: null,
    occasion: [], season: [], colors: [], notes: "", dateAdded: todayISO(), status: "saved", resultDesignId: null
  };
}
function initWishlistDraft(existingId) {
  if (existingId) {
    const existing = state.wishlist.find(function (w) { return w.id === existingId; });
    wishDraft = existing ? Object.assign(makeDefaultWishDraft(), JSON.parse(JSON.stringify(existing))) : makeDefaultWishDraft();
    wishDraft.season = seasonArray(wishDraft);
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
      '<input class="form-input" id="field-thumb-url" placeholder="https://…" value="' + (wishDraft._thumbFile ? "" : esc(wishDraft.thumbnailUrl)) + '" style="margin-top:6px;"></div>' +
    '<div class="form-section"><label class="form-label">Title</label><input class="form-input" id="field-title" placeholder="e.g. Almond French with gold foil" value="' + esc(wishDraft.title) + '"></div>' +
    '<div class="form-section"><label class="form-label">Source link</label><input class="form-input" id="field-source" type="url" placeholder="Pinterest or any link" value="' + esc(wishDraft.sourceUrl) + '"></div>' +
    '<div class="form-section"><label class="form-label">Occasion</label><div class="chip-row">' +
      OCCASIONS.map(function (o) { return chipHTML("occasion", o, o, wishDraft.occasion.indexOf(o) >= 0, "pink", "wish-multi"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Season</label><div class="chip-row">' +
      SEASONS.map(function (s) { return chipHTML("season", s, s, wishDraft.season.indexOf(s) >= 0, "blue", "wish-multi"); }).join("") + "</div></div>" +
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
      wishDraft._thumbFile = file;
      wishDraft._thumbLocalPreview = URL.createObjectURL(blob);
      refresh();
    }).catch(function () { showToast("Could not read that image — try another.", { error: true }); });
  });
  document.getElementById("field-thumb-url").addEventListener("input", function (e) {
    wishDraft.thumbnailUrl = e.target.value;
    wishDraft._thumbFile = null;
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
    const titleField = document.getElementById("field-title");
    if (!title) {
      showToast("Give it a title first.", { error: true });
      shakeField(titleField);
      titleField.focus();
      return;
    }
    const isNew = !existingId;
    const saveBtn = document.getElementById("wish-form-save");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    Promise.resolve(wishDraft._thumbFile ? compressPhotoToDataURL(wishDraft._thumbFile) : wishDraft.thumbnailUrl)
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
        showToast(isNew ? "Added to your wishlist" : "Wishlist item updated");
      }).catch(function () {
        showToast("Could not save — check your connection and try again.", { error: true });
        saveBtn.disabled = false; saveBtn.textContent = "Save";
      });
  });
}

/* ── nail profile (preferences learned from history) ───────── */
/* Every design votes for its technique, shape and any styles its notes
   mention, weighted by how much she liked it — a "Love" she'd repeat
   counts far more than a "Meh", and a "Skip" counts against. Saved
   wishlist items vote for the styles in their title/notes (that's what
   she wants next); tried ones vote with their result design's weight. */
function designWeight(d) {
  const w = RATING_WEIGHTS[d.rating];
  return (w === undefined ? 1 : w) + (d.wouldRepeat ? 1 : 0);
}
function buildNailProfile(designs, wishlist) {
  const tally = { technique: {}, shape: {}, style: {} };
  function add(kind, value, weight) {
    const t = tally[kind][value] || (tally[kind][value] = { value: value, score: 0, count: 0 });
    t.score += weight;
    t.count += 1;
  }
  function addStyles(text, weight) {
    NAIL_STYLES.forEach(function (st) { if (st.pattern.test(text)) add("style", st.id, weight); });
  }
  designs.forEach(function (d) {
    const w = designWeight(d);
    if (TECHNIQUE_SEARCH_TERMS[d.technique]) add("technique", d.technique, w);
    if (d.shape) add("shape", d.shape, w);
    addStyles(d.notes || "", w);
  });
  wishlist.forEach(function (item) {
    const result = item.resultDesignId ? designs.find(function (d) { return d.id === item.resultDesignId; }) : null;
    addStyles([item.title, item.notes].filter(Boolean).join(" "), result ? designWeight(result) : 1.5);
  });
  function ranked(kind) {
    return Object.keys(tally[kind]).map(function (k) { return tally[kind][k]; })
      .filter(function (t) { return t.score > 0; })
      .sort(function (a, b) { return b.score - a.score || b.count - a.count; });
  }
  return {
    technique: ranked("technique"), shape: ranked("shape"), style: ranked("style"),
    designCount: designs.length, wishCount: wishlist.length
  };
}
function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
/* Names the top pick, plus the runner-up only when it's a real contender
   (a lone "Meh" shouldn't read as something she's "mostly" into). */
function topNames(list) {
  return list.slice(0, 2).filter(function (t, i) { return i === 0 || t.score >= list[0].score / 2; })
    .map(function (t) { return t.value; }).join(" & ");
}
function profileSummaryText(p) {
  const parts = [];
  if (p.technique.length) parts.push("mostly " + topNames(p.technique));
  if (p.shape.length) parts.push(p.shape[0].value + " shape");
  if (p.style.length) parts.push("into " + topNames(p.style));
  if (!parts.length) return "Log and rate a few designs and this will learn what you like. For now, pick what you're after.";
  const sources = [plural(p.designCount, "design")];
  if (p.wishCount) sources.push(plural(p.wishCount, "wishlist item"));
  return "From your " + sources.join(" and ") + ": " + parts.join(", ") + ".";
}

/* ── salon search (Google Maps links) ──────────────────────── */
const SALON_TERM_GROUPS = [
  { kind: "technique", label: "Technique", tone: "pink", options: Object.keys(TECHNIQUE_SEARCH_TERMS) },
  { kind: "style", label: "Style", tone: "sage", options: NAIL_STYLES.map(function (st) { return st.id; }) },
  { kind: "shape", label: "Shape", tone: "blue", options: SHAPES }
];
function defaultSalonTerms(profile) {
  const keys = [];
  if (profile.technique[0]) keys.push("technique:" + profile.technique[0].value);
  if (profile.style[0]) keys.push("style:" + profile.style[0].value);
  return keys;
}
function selectedSalonTerms(profile) {
  return state.salonSearch.selected || defaultSalonTerms(profile);
}
function salonSearchTerm(key) {
  const i = key.indexOf(":"), kind = key.slice(0, i), value = key.slice(i + 1);
  if (kind === "technique") return TECHNIQUE_SEARCH_TERMS[value] || "";
  if (kind === "style") {
    const st = NAIL_STYLES.find(function (x) { return x.id === value; });
    return st ? st.term : "";
  }
  if (kind === "shape") return SHAPES.indexOf(value) >= 0 ? value.toLowerCase() + " nails" : "";
  return "";
}
/* "near me" lets the Maps app use the phone's own location, so "where I
   am" needs no geolocation permission here — and it's also the fallback
   when the home/other field is still blank. */
function salonPlacePhrase(s) {
  const place = s.near === "home" ? s.home.trim() : s.near === "other" ? s.other.trim() : "";
  return place ? "near " + place : "near me";
}
function buildSalonQueries(s, selectedKeys) {
  const order = SALON_TERM_GROUPS.map(function (g) { return g.kind; });
  const terms = selectedKeys.slice()
    .sort(function (a, b) { return order.indexOf(a.split(":")[0]) - order.indexOf(b.split(":")[0]); })
    .map(salonSearchTerm).filter(Boolean);
  const extras = s.extras.trim();
  const suffix = " " + salonPlacePhrase(s) + (s.openNow ? " open now" : "");
  const main = ["nail salon"].concat(terms, extras ? [extras] : []).join(" ") + suffix;
  const focused = terms.length > 1 ? terms.map(function (t) { return t + suffix; }) : [];
  return { main: main, focused: focused };
}
function mapsSearchUrl(query) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
}
function safeHttpUrl(url) {
  return /^https?:\/\//i.test(url || "") ? url : "";
}

/* ── saved salons ──────────────────────────────────────────── */
/* Designs link to a salon by name (the design's Location field), so
   designs logged before the salon was saved still count, and nothing
   needs re-linking if a salon is deleted. */
function normalizeName(str) { return String(str || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function designsAtSalon(salon) {
  const n = normalizeName(salon.name);
  if (!n) return [];
  return sortDesigns(state.designs.filter(function (d) { return normalizeName(d.location) === n; }), "date");
}
function markSalonTried(location) {
  const n = normalizeName(location);
  if (!n) return;
  state.salons.filter(function (x) { return x.status === "want" && normalizeName(x.name) === n; })
    .forEach(function (x) { upsertSalon(Object.assign({}, x, { status: "tried", updatedAt: Date.now() })); });
}
function salonStatusLabel(status) {
  const cfg = SALON_STATUSES.find(function (x) { return x.id === status; });
  return cfg ? cfg.label : "Want to try";
}
function salonStatusPillHTML(status) {
  return '<span class="wish-status salon-status-' + esc(status || "want") + '">' + esc(salonStatusLabel(status)) + "</span>";
}
function salonMapsUrl(salon) {
  return safeHttpUrl(salon.mapsUrl) || mapsSearchUrl([salon.name, salon.neighborhood].filter(Boolean).join(" "));
}
function getSalonOrderedList() {
  const rank = { favorite: 0, want: 1, tried: 2 };
  return state.salons.slice().sort(function (a, b) {
    return (rank[a.status] === undefined ? 1 : rank[a.status]) - (rank[b.status] === undefined ? 1 : rank[b.status]) ||
      (a.name || "").localeCompare(b.name || "");
  });
}

/* ── salons tab ────────────────────────────────────────────── */
function salonsHTML() {
  const s = state.salonSearch;
  const profile = buildNailProfile(state.designs, state.wishlist);
  const selected = selectedSalonTerms(profile);
  const termGroups = SALON_TERM_GROUPS.map(function (g) {
    const byValue = {};
    profile[g.kind].forEach(function (t) { byValue[t.value] = t; });
    const options = g.options.slice().sort(function (a, b) {
      return ((byValue[b] || {}).score || 0) - ((byValue[a] || {}).score || 0) || g.options.indexOf(a) - g.options.indexOf(b);
    });
    return '<div class="filter-group"><div class="filter-label">' + g.label + '</div><div class="chip-row">' +
      options.map(function (v) {
        const label = v + (byValue[v] ? " · " + byValue[v].count : "");
        return chipHTML(g.kind, v, label, selected.indexOf(g.kind + ":" + v) >= 0, g.tone, "salon-term");
      }).join("") + "</div></div>";
  }).join("");
  return "" +
    '<h2 class="section-heading">Find a salon</h2>' +
    '<div class="profile-card">' +
      '<div class="form-label">What you&rsquo;re after</div>' +
      '<p class="profile-summary">' + esc(profileSummaryText(profile)) + "</p>" +
      termGroups +
      '<div class="field-hint">Numbers show how often each one turns up in designs you liked and your wishlist.</div>' +
    "</div>" +
    '<div class="form-section"><label class="form-label">Near</label><div class="chip-row">' +
      [["home", "Home"], ["me", "Where I am"], ["other", "Somewhere else"]].map(function (p) {
        return chipHTML("near", p[0], p[1], s.near === p[0], "neutral", "salon-near");
      }).join("") + "</div>" +
      '<input class="form-input salon-near-input" id="salon-home" placeholder="Home neighborhood or cross streets, e.g. Williamsburg, Brooklyn" value="' + esc(s.home) + '"' + (s.near === "home" ? "" : " hidden") + ">" +
      '<input class="form-input salon-near-input" id="salon-other" placeholder="Neighborhood, address or landmark" value="' + esc(s.other) + '"' + (s.near === "other" ? "" : " hidden") + ">" +
    "</div>" +
    '<div class="form-section"><label class="form-label">Anything else?</label>' +
      '<input class="form-input" id="salon-extras" placeholder="e.g. pedicure, walk-ins, non-toxic" value="' + esc(s.extras) + '"></div>' +
    '<div class="form-section"><div class="toggle-row"><span>Open now</span><label class="switch">' +
      '<input type="checkbox" id="salon-open-now"' + (s.openNow ? " checked" : "") + '><span class="switch-track"></span><span class="switch-thumb"></span></label></div></div>' +
    '<div id="salon-search-output"></div>' +
    '<h2 class="section-heading">My salons</h2>' +
    '<div class="filters-bar"><span class="result-line" id="salon-result-line"></span>' +
      '<button type="button" class="btn-text" id="salon-add-btn">+ Add salon</button></div>' +
    '<div id="salon-list"></div>';
}
function updateSalonSearchOutput() {
  const profile = buildNailProfile(state.designs, state.wishlist);
  const q = buildSalonQueries(state.salonSearch, selectedSalonTerms(profile));
  document.getElementById("salon-search-output").innerHTML = "" +
    '<div class="query-preview">Searches Google Maps for <strong>&ldquo;' + esc(q.main) + "&rdquo;</strong></div>" +
    '<a class="btn btn-primary btn-block btn-link" href="' + esc(mapsSearchUrl(q.main)) + '" target="_blank" rel="noopener">Search Google Maps</a>' +
    (q.focused.length ? '<div class="form-label" style="margin-top:var(--space-4);">Or one thing at a time</div>' +
      q.focused.map(function (f) {
        return '<a class="focus-search" href="' + esc(mapsSearchUrl(f)) + '" target="_blank" rel="noopener"><span>' + esc(f) + "</span>" + chevronRightSVG() + "</a>";
      }).join("") : "") +
    '<div class="field-hint salon-tip">Tip: in Maps, tap <strong>Rating</strong> to show 4.5&#9733; and up, and skim the newest reviews for mentions of what you like. Found a keeper? Save it below.</div>';
}
function salonCardHTML(salon) {
  const visits = designsAtSalon(salon);
  const withPhoto = visits.find(function (d) { return d.photoUrl; });
  const best = sortDesigns(visits.filter(function (d) { return d.rating; }), "rating")[0];
  const thumb = withPhoto
    ? '<img class="wish-thumb fade-img" src="' + esc(withPhoto.photoUrl) + '" loading="lazy" alt="">'
    : '<div class="wish-thumb-empty">' + pinSVG() + "</div>";
  const meta = [salon.neighborhood, visits.length ? plural(visits.length, "design") : ""].filter(Boolean).join(" · ");
  return '<div class="wish-card" data-open-salon="' + salon.id + '">' + thumb +
    '<div class="wish-body">' + salonStatusPillHTML(salon.status) +
    '<div class="wish-title">' + esc(salon.name || "Untitled") + "</div>" +
    '<div class="wish-meta salon-meta">' + (best ? ratingIconSVG(best.rating, 12, "card-rating") : "") + "<span>" + esc(meta) + "</span></div></div></div>";
}
function updateSalonList() {
  const list = getSalonOrderedList();
  document.getElementById("salon-result-line").textContent = plural(list.length, "salon");
  const container = document.getElementById("salon-list");
  if (!list.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-title">No saved salons yet</div>' +
      '<div class="empty-body">When a place looks promising in Maps, add it here so you remember to try it.</div></div>';
    return;
  }
  container.innerHTML = list.map(salonCardHTML).join("");
}
function bindSalonsEvents() {
  updateSalonSearchOutput();
  updateSalonList();
  const root = document.getElementById("view-root");
  const s = state.salonSearch;
  function changed() { saveSalonSearch(); updateSalonSearchOutput(); }
  root.querySelectorAll('[data-chip-mode="salon-term"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const key = btn.dataset.chipGroup + ":" + btn.dataset.chipValue;
      const sel = selectedSalonTerms(buildNailProfile(state.designs, state.wishlist)).slice();
      const i = sel.indexOf(key);
      if (i >= 0) sel.splice(i, 1); else sel.push(key);
      s.selected = sel;
      btn.classList.toggle("active", i < 0);
      changed();
    });
  });
  root.querySelectorAll('[data-chip-mode="salon-near"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      s.near = btn.dataset.chipValue;
      root.querySelectorAll('[data-chip-mode="salon-near"]').forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.getElementById("salon-home").hidden = s.near !== "home";
      document.getElementById("salon-other").hidden = s.near !== "other";
      changed();
    });
  });
  document.getElementById("salon-home").addEventListener("input", function (e) { s.home = e.target.value; changed(); });
  document.getElementById("salon-other").addEventListener("input", function (e) { s.other = e.target.value; changed(); });
  document.getElementById("salon-extras").addEventListener("input", function (e) { s.extras = e.target.value; changed(); });
  document.getElementById("salon-open-now").addEventListener("change", function (e) { s.openNow = e.target.checked; changed(); });
  document.getElementById("salon-add-btn").addEventListener("click", function () { navigate("#/salons/add"); });
  document.getElementById("salon-list").addEventListener("click", function (e) {
    const card = e.target.closest("[data-open-salon]");
    if (card) navigate("#/salons/" + card.dataset.openSalon);
  });
}

/* ── salon detail ──────────────────────────────────────────── */
function salonDetailHTML(id) {
  const salon = state.salons.find(function (x) { return x.id === id; });
  if (!salon) return notFoundHTML();
  const visits = designsAtSalon(salon);
  return '<div class="detail-topbar"><button class="icon-btn" id="detail-back" aria-label="Back">' + backArrowSVG() + "</button>" +
      '<div style="display:flex;gap:8px;"><button class="icon-btn" id="detail-edit" aria-label="Edit">' + editSVG() + "</button>" +
      '<button class="icon-btn" id="detail-delete" aria-label="Delete">' + trashSVG() + "</button></div></div>" +
    '<h2 class="salon-name">' + esc(salon.name) + "</h2>" +
    (salon.neighborhood ? '<div class="salon-neighborhood">' + esc(salon.neighborhood) + "</div>" : "") +
    '<div class="chip-row salon-status-row">' +
      SALON_STATUSES.map(function (st) { return chipHTML("status", st.id, st.label, (salon.status || "want") === st.id, "pink", "salon-status"); }).join("") + "</div>" +
    '<div class="detail-actions salon-actions">' +
      '<a class="btn btn-primary btn-link" href="' + esc(salonMapsUrl(salon)) + '" target="_blank" rel="noopener">Open in Maps</a>' +
      '<button type="button" class="btn btn-secondary" id="salon-log-design">Log a design here</button></div>' +
    (salon.notes ? '<div class="detail-notes">' + esc(salon.notes).replace(/\n/g, "<br>") + "</div>" : "") +
    '<div class="filter-label">Your designs here</div>' +
    (visits.length
      ? '<div class="grid">' + visits.map(designCardHTML).join("") + "</div>"
      : '<div class="field-hint" style="margin-bottom:var(--space-4);">Designs logged with the location &ldquo;' + esc(salon.name) + "&rdquo; will show up here.</div>") +
    '<div class="detail-field"><div class="detail-field-label">Saved</div><div class="detail-field-value">' + esc(formatDate(salon.dateAdded)) + "</div></div>";
}
function bindSalonDetailEvents(id) {
  const salon = state.salons.find(function (x) { return x.id === id; });
  if (!salon) return;
  document.getElementById("detail-back").addEventListener("click", function () { navigate("#/salons"); });
  document.getElementById("detail-edit").addEventListener("click", function () { navigate("#/salons/" + id + "/edit"); });
  document.getElementById("detail-delete").addEventListener("click", function () {
    showConfirmSheet("Remove this salon? Your designs from there stay in your gallery.", "Remove", function () {
      removeSalon(id);
      navigate("#/salons");
      showToast("Salon removed");
    });
  });
  document.getElementById("view-root").querySelectorAll('[data-chip-mode="salon-status"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      upsertSalon(Object.assign({}, salon, { status: btn.dataset.chipValue, updatedAt: Date.now() }));
      renderRoute();
    });
  });
  document.getElementById("salon-log-design").addEventListener("click", function () { navigate("#/design/new/at/" + id); });
  const grid = document.querySelector("#view-root .grid");
  if (grid) grid.addEventListener("click", function (e) {
    const card = e.target.closest("[data-open-design]");
    if (card) navigate("#/design/" + card.dataset.openDesign);
  });
}

/* ── add / edit salon ──────────────────────────────────────── */
let salonDraft = null;
function makeDefaultSalonDraft() {
  return { id: uid(), name: "", neighborhood: "", mapsUrl: "", status: "want", notes: "", dateAdded: todayISO() };
}
function initSalonDraft(existingId) {
  const existing = existingId ? state.salons.find(function (x) { return x.id === existingId; }) : null;
  salonDraft = Object.assign(makeDefaultSalonDraft(), existing ? JSON.parse(JSON.stringify(existing)) : {});
}
function salonFormBodyHTML() {
  return "" +
    '<div class="form-section"><label class="form-label">Name</label><input class="form-input" id="field-salon-name" placeholder="e.g. Glossy Nail Studio" value="' + esc(salonDraft.name) + '"></div>' +
    '<div class="form-section"><label class="form-label">Neighborhood or address</label><input class="form-input" id="field-salon-hood" placeholder="e.g. Williamsburg" value="' + esc(salonDraft.neighborhood) + '"></div>' +
    '<div class="form-section"><label class="form-label">Google Maps link</label><input class="form-input" id="field-salon-maps" type="url" placeholder="https://maps.app.goo.gl/…" value="' + esc(salonDraft.mapsUrl) + '">' +
      '<div class="field-hint">Optional. In Google Maps, tap Share &rarr; Copy link, then paste it here.</div></div>' +
    '<div class="form-section"><label class="form-label">Status</label><div class="chip-row">' +
      SALON_STATUSES.map(function (st) { return chipHTML("status", st.id, st.label, salonDraft.status === st.id, "pink", "salon-form-status"); }).join("") + "</div></div>" +
    '<div class="form-section"><label class="form-label">Notes</label><textarea class="form-textarea" id="field-salon-notes" placeholder="Prices, who to book with, what reviews said…">' + esc(salonDraft.notes) + "</textarea></div>" +
    '<div class="form-actions"><button type="button" class="btn btn-outline" id="salon-form-cancel">Cancel</button><button type="button" class="btn btn-primary" id="salon-form-save">Save</button></div>';
}
function bindSalonFormEvents(existingId) {
  const root = document.getElementById("view-root");
  document.getElementById("field-salon-name").addEventListener("input", function (e) { salonDraft.name = e.target.value; });
  document.getElementById("field-salon-hood").addEventListener("input", function (e) { salonDraft.neighborhood = e.target.value; });
  document.getElementById("field-salon-maps").addEventListener("input", function (e) { salonDraft.mapsUrl = e.target.value; });
  document.getElementById("field-salon-notes").addEventListener("input", function (e) { salonDraft.notes = e.target.value; });
  root.querySelectorAll('[data-chip-mode="salon-form-status"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      salonDraft.status = btn.dataset.chipValue;
      root.querySelectorAll('[data-chip-mode="salon-form-status"]').forEach(function (b) { b.classList.toggle("active", b === btn); });
    });
  });
  document.getElementById("salon-form-cancel").addEventListener("click", function () {
    salonDraft = null;
    navigate(existingId ? "#/salons/" + existingId : "#/salons");
  });
  document.getElementById("salon-form-save").addEventListener("click", function () {
    const name = salonDraft.name.trim();
    const nameField = document.getElementById("field-salon-name");
    if (!name) {
      showToast("Give it a name first.", { error: true });
      shakeField(nameField);
      nameField.focus();
      return;
    }
    const mapsUrl = salonDraft.mapsUrl.trim();
    if (mapsUrl && !safeHttpUrl(mapsUrl)) {
      showToast("That Maps link should start with https://", { error: true });
      shakeField(document.getElementById("field-salon-maps"));
      return;
    }
    const salon = {
      id: salonDraft.id, name: name, neighborhood: salonDraft.neighborhood.trim(), mapsUrl: mapsUrl,
      status: salonDraft.status || "want", notes: salonDraft.notes, dateAdded: salonDraft.dateAdded || todayISO(),
      updatedAt: Date.now()
    };
    upsertSalon(salon);
    salonDraft = null;
    navigate("#/salons/" + salon.id);
    showToast(existingId ? "Salon updated" : "Salon saved");
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
  if (unsubSalons) unsubSalons();
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
    const root = document.getElementById("view-root");
    if (root) root.scrollTop = 0;
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
