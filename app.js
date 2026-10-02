/* NOVA Smart Local
 * Part 1: pure business logic (no DOM) — exported so tests.js can verify it in Node and the browser.
 * Part 2: UI layer — only starts when index.html is open (it needs the #products element).
 */
(function (root) {
  "use strict";

  const BACKUP_STORE = "Rythu Partner Store";
  const LOW_STOCK_LIMIT = 5;
  const MAX_FIELD_LENGTH = 60;

  // Fresh copy each call so callers (and tests) never share mutable state.
  const createProducts = () => [
    { id: "rice", name: "Basmati Rice 5kg", price: 620, stock: 12, store: "Sri Lakshmi Store", confidence: 96, eta: "28–35 min" },
    { id: "milk", name: "Fresh Milk 1L", price: 62, stock: 4, store: "Village Fresh Mart", confidence: 88, eta: "18–25 min" },
    { id: "honey", name: "Local Honey 500g", price: 280, stock: 0, store: BACKUP_STORE, confidence: 0, eta: "Backup required" }
  ];

  /**
   * Escapes user-controlled text before it is placed in innerHTML.
   * @param {*} x any value
   * @returns {string} HTML-safe string
   */
  function esc(x) {
    return String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** Case-insensitive name search; an empty query returns everything. */
  function searchProducts(products, query) {
    const term = String(query || "").toLowerCase().trim();
    return products.filter(p => !term || p.name.toLowerCase().includes(term));
  }

  /**
   * Locks stock for an order. Never lets stock go negative.
   * @returns {{ok: boolean, product?: object, reason?: string, backupStore?: string}}
   */
  function reserveStock(products, id, qty = 1) {
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: "invalid_quantity" };
    const product = products.find(p => p.id === id);
    if (!product) return { ok: false, reason: "not_found" };
    if (product.stock < qty) return { ok: false, reason: "unavailable", backupStore: BACKUP_STORE };
    product.stock -= qty;
    return { ok: true, product };
  }

  // Partner store sells one unit in-store; stock floors at 0.
  function sellOne(products, id) {
    const product = products.find(p => p.id === id);
    if (!product) return null;
    product.stock = Math.max(0, product.stock - 1);
    return product;
  }

  const ROLES = Object.freeze([
    { name: "Customer", section: "customer" },
    { name: "Community Store", section: "community" },
    { name: "Partner Store", section: "store" },
    { name: "HQ", section: "control" }
  ].map(Object.freeze));

  // Cycles Customer -> Community Store -> Partner Store -> HQ -> Customer. Unknown names restart at Customer.
  function nextRole(currentName) {
    const i = ROLES.findIndex(r => r.name === currentName);
    return ROLES[(i + 1) % ROLES.length];
  }

  // Text/badge info for a product card, derived from stock.
  function availabilityInfo(p) {
    return p.stock > 0
      ? { label: "Available", badge: "green", cta: "Pre-book", detail: `Availability confidence ${p.confidence}% • ${p.eta}` }
      : { label: "Unavailable", badge: "red", cta: "Find backup", detail: "NOVA can search a nearby partner store." };
  }

  // Order tracking steps. `stage` = number of completed steps (0-4).
  function buildTimeline(stage = 2) {
    const steps = [
      ["Booked", "Customer request accepted"], ["Reserved", "Stock locked"],
      ["Local handover", "Community checkpoint"], ["Delivered", "Customer receives item"]
    ];
    return steps.map(([title, detail], i) => ({
      title, detail,
      icon: i < stage ? "✓" : String(i + 1),
      status: i < stage ? "done" : i === stage ? "current" : "pending"
    }));
  }

  /** Stock badge for the partner-store panel: Unavailable / Low / In stock. */
  function stockLevel(p) {
    if (p.stock === 0) return { label: "Unavailable", badge: "red" };
    return p.stock <= LOW_STOCK_LIMIT ? { label: "Low", badge: "orange" } : { label: "In stock", badge: "green" };
  }

  /**
   * Validates the Community Store assisted-booking form.
   * @returns {{valid: boolean, errors: object, values: {name: string, village: string}}}
   */
  function validateAssist({ name = "", village = "" } = {}) {
    const clean = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_LENGTH);
    const values = { name: clean(name), village: clean(village) };
    const errors = {};
    if (values.name.length < 2) errors.name = "Enter the customer's name (2+ letters).";
    if (values.village.length < 2) errors.village = "Enter the village name.";
    return { valid: Object.keys(errors).length === 0, errors, values };
  }

  function mapsSearchUrl(query) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
  }

  const STORE_QUERY = "Sri Lakshmi Store";

  // Google Maps embed URL (no API key needed).
  function mapsEmbedUrl(query) {
    return "https://www.google.com/maps?output=embed&q=" + encodeURIComponent(query);
  }

  // Google Calendar "add event" link. start/end are Date objects.
  function calendarUrl({ title, details = "", start, end }) {
    const fmt = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
    return "https://calendar.google.com/calendar/render?action=TEMPLATE"
      + "&text=" + encodeURIComponent(title)
      + "&details=" + encodeURIComponent(details)
      + "&dates=" + fmt(start) + "/" + fmt(end);
  }

  const api = Object.freeze({
    BACKUP_STORE, STORE_QUERY, ROLES, nextRole, availabilityInfo, buildTimeline, mapsSearchUrl, mapsEmbedUrl,
    calendarUrl, createProducts, esc, searchProducts, reserveStock, sellOne,
    stockLevel, validateAssist, LOW_STOCK_LIMIT, MAX_FIELD_LENGTH
  });
  root.NovaLogic = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* ---------- Part 2: UI layer ---------- */
(() => {
  "use strict";
  if (typeof document === "undefined" || !document.getElementById("products")) return;

  const { createProducts, esc, searchProducts, reserveStock, sellOne, availabilityInfo, buildTimeline,
    mapsSearchUrl, mapsEmbedUrl, calendarUrl, nextRole, stockLevel, validateAssist, STORE_QUERY } = globalThis.NovaLogic;

  const products = createProducts();
  const state = { events: 0, pending: null, role: "Customer", query: "", productsHtml: "", stockHtml: "" };

  // Cache element lookups: each selector hits the DOM once (cached nodes are static).
  const cache = new Map();
  const $ = (selector) => {
    if (!cache.has(selector)) cache.set(selector, document.querySelector(selector));
    return cache.get(selector);
  };
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  /* ---------- Small UI helpers ---------- */

  function countEvent() {
    state.events += 1;
    $("#kpi").textContent = state.events;
  }

  function notify(message) {
    const el = $("#notice");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => el.classList.remove("show"), 2500);
    countEvent();
  }

  function openModal(title, html) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = html;
    $("#modal").showModal();
  }

  const closeModal = () => $("#modal").close();

  function setOrderStatus(text, badge) {
    const el = $("#orderStatus");
    el.textContent = text;
    el.className = `badge ${badge}`;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  /* ---------- Rendering ---------- */

  function productCard(p) {
    const info = availabilityInfo(p);
    return `
      <article class="product">
        <span class="badge ${info.badge}">${info.label}</span>
        <h3>${esc(p.name)}</h3>
        <small>₹${p.price} • ${esc(p.store)}</small>
        <small>${esc(info.detail)}</small>
        <div class="buttons">
          <button class="primary book" data-id="${esc(p.id)}">${info.cta}</button>
          <button class="secondary trust" data-id="${esc(p.id)}">Trust</button>
        </div>
      </article>`;
  }

  function renderProducts(query = state.query) {
    state.query = query;
    const list = searchProducts(products, query);
    const html = list.length
      ? list.map(productCard).join("")
      : "<article class='card'><b>No product found.</b><p>Try another search or ask the Community Store.</p></article>";
    if (html === state.productsHtml) return; // nothing changed: skip DOM work
    state.productsHtml = html;
    $("#products").innerHTML = html;
  }

  function renderTimeline() {
    $("#timeline").innerHTML = buildTimeline(2).map((step) => `
      <div class="t ${step.status === "pending" ? "" : step.status}">
        <span class="dot">${step.icon}</span>
        <div><b>${step.title}</b><small>${step.detail}</small></div>
      </div>`).join("");
  }

  function stockRow(p) {
    const level = stockLevel(p);
    const action = p.id === "rice"
      ? `<button id="sell" class="primary mini" aria-label="Sell one ${esc(p.name)}">Sell 1</button>`
      : `<span class="badge ${level.badge}">${level.label}</span>`;
    return `<div class="stock"><span><b>${esc(p.name)}</b><small>${p.stock} available</small></span>${action}</div>`;
  }

  // Stock panel is generated from the same data as the product cards, so the two can never disagree.
  function renderStockPanel() {
    const html = products.map(stockRow).join("");
    if (html === state.stockHtml) return;
    state.stockHtml = html;
    $("#stockList").innerHTML = html;
  }

  function refreshStock() {
    renderProducts();
    renderStockPanel();
  }

  /* ---------- Modals ---------- */

  function openTrust(p) {
    openModal("Product Trust", `
      <div class="callout"><b>Verified demo traceability</b>
        <p>Source: ${esc(p.store)}<br>Batch: BAT-2026-041<br>Best before: 20 Sep 2027<br>Customer: linked to order #NSL-1042</p>
      </div>
      <p class="muted">In production, source, batch and expiry values should come from authenticated store/farmer/company records.</p>`);
  }

  function openBooking(p) {
    state.pending = p;
    if (p.stock === 0) {
      openModal("Backup Local Store", `
        <p><b>${esc(p.name)}</b> is unavailable in the selected store.</p>
        <p>Recommendation: reserve from <b>Rythu Partner Store</b>.</p>
        <button id="backup" class="primary full">Reserve backup store</button>`);
      return;
    }
    openModal("Pre-book + Stock Lock", `
      <p><b>${esc(p.name)}</b> is currently available.</p>
      <p>Store: ${esc(p.store)}<br>Availability confidence: ${p.confidence}%<br>Estimated delivery: ${esc(p.eta)}</p>
      <button id="confirm" class="primary full">Confirm reservation</button>`);
  }

  const modalButton = (id, label) => `<button id="${id}" class="primary full">${label}</button>`;

  const MODALS = {
    assist: () => openModal("Community Store Assisted Order", `
      <p>The operator can place the order for the customer and confirm choices.</p>
      <div class="formrow"><label for="custName">Customer name</label><input id="custName" placeholder="Enter customer name" maxlength="60"
        autocomplete="off" required aria-describedby="assistError"></div>
      <div class="formrow"><label for="custVillage">Village</label><input id="custVillage" placeholder="Enter village" maxlength="60"
        autocomplete="off" required aria-describedby="assistError"></div>
      <p id="assistError" class="error" role="alert"></p>
      ${modalButton("assistConfirm", "Create assisted booking")}`),
    trust: () => openTrust(products[0]),
    reward: () => openModal("Experience Rewards", `
      <p>Instead of relying only on confusing coupons, NOVA can offer clear partner experiences.</p>
      <p>Examples: movie, dining or travel offers, subject to partner terms.</p>
      <div class="callout"><b>Proposed NOVA 15× Dine</b><br>15 eligible orders in a month → proposed dinner for two up to ₹1,500.</div>`),
    call: () => openModal("Protected Customer Contact", `
      <p>Use a platform-controlled or masked calling workflow so personal phone numbers are not exposed.</p>
      ${modalButton("call", "Start protected call")}`),
    replacement: () => openModal("Replacement", `
      <p>Choose a replacement from verified nearby stock.</p>${modalButton("replace", "Confirm replacement")}`),
    alternative: () => openModal("Alternative Product", `
      <p>Show a similar verified product with price and availability before customer confirmation.</p>
      ${modalButton("alt", "Show alternatives")}`),
    refund: () => openModal("Refund / Resolution", `
      <p>First offer a replacement or alternative when appropriate. If the customer chooses refund, create a traceable refund request.</p>
      ${modalButton("refund", "Create refund request")}`)
  };

  /* ---------- Actions (button id -> handler) ---------- */

  function confirmReservation() {
    const result = reserveStock(products, state.pending && state.pending.id);
    closeModal();
    if (!result.ok) {
      notify("Sorry, that item just went out of stock.");
      refreshStock();
      return;
    }
    setOrderStatus("Reserved • #NSL-1042", "green");
    renderTimeline();
    refreshStock();
    notify("Stock reserved and inventory updated.");
  }

  function reserveBackup() {
    closeModal();
    setOrderStatus("Backup reserved • #NSL-1042", "blue");
    renderTimeline();
    notify("Nearby partner store reserved.");
  }

  const done = (message) => () => { closeModal(); notify(message); };

  function showAlternatives() {
    openModal("Alternatives", `
      <p>1. Local Honey 500g — ₹280 — verified partner stock</p>
      <p>2. Forest Honey 500g — ₹310 — verified partner stock</p>
      ${modalButton("chooseAlt", "Choose first alternative")}`);
  }

  // Validates the assisted-booking form; shows errors inline instead of silently succeeding.
  function confirmAssisted() {
    const nameEl = document.getElementById("custName");
    const villageEl = document.getElementById("custVillage");
    const { valid, errors, values } = validateAssist({ name: nameEl.value, village: villageEl.value });
    nameEl.setAttribute("aria-invalid", String(Boolean(errors.name)));
    villageEl.setAttribute("aria-invalid", String(Boolean(errors.village)));
    document.getElementById("assistError").textContent = errors.name || errors.village || "";
    if (!valid) { (errors.name ? nameEl : villageEl).focus(); return; }
    closeModal();
    notify(`Assisted booking created for ${values.name}, ${values.village}.`);
  }

  function sellInStore() {
    sellOne(products, "rice");
    refreshStock();
    notify("Stock updated immediately across the demo.");
  }

  const ACTIONS = {
    sell: sellInStore,
    confirm: confirmReservation,
    backup: reserveBackup,
    assistConfirm: confirmAssisted,
    call: done("Protected call flow started."),
    replace: done("Replacement confirmed."),
    alt: showAlternatives,
    chooseAlt: done("Alternative selected for customer confirmation."),
    refund: done("Traceable refund request created.")
  };

  /* ---------- Event wiring ---------- */

  function handleClick(e) {
    const target = e.target;
    const bookBtn = target.closest(".book");
    const trustBtn = target.closest(".trust");
    const openBtn = target.closest("[data-open]");
    const find = (btn) => products.find((p) => p.id === btn.dataset.id);

    if (bookBtn) { countEvent(); openBooking(find(bookBtn)); return; }
    if (trustBtn) { countEvent(); openTrust(find(trustBtn)); return; }
    if (openBtn) { countEvent(); (MODALS[openBtn.dataset.open] || (() => {}))(); return; }
    if (ACTIONS[target.id]) { ACTIONS[target.id](); return; }
    if (target.matches("[data-check]")) {
      notify(`${target.dataset.check} checkpoint recorded.`);
      target.classList.add("done");
      target.setAttribute("aria-pressed", "true");
    }
  }

  // Loads the Google Maps embed only when asked, so the page stays light.
  function toggleMap() {
    const box = $("#mapBox");
    const btn = $("#showMap");
    const opening = !box.firstChild;
    box.textContent = "";
    if (opening) {
      const frame = document.createElement("iframe");
      frame.className = "map";
      frame.title = `Google Map showing ${STORE_QUERY}`;
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer-when-downgrade";
      frame.src = mapsEmbedUrl(STORE_QUERY);
      box.appendChild(frame);
      countEvent();
    }
    btn.setAttribute("aria-expanded", String(opening));
    btn.textContent = opening ? "Hide map" : "Show map here";
  }

  function addCalendarReminder() {
    const start = new Date(Date.now() + 30 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    countEvent();
    window.open(calendarUrl({
      title: "NOVA delivery #NSL-1042",
      details: "Reminder: collect your NOVA Smart Local order.",
      start, end
    }), "_blank", "noopener,noreferrer");
  }

  function switchRole() {
    const role = nextRole(state.role);
    state.role = role.name;
    $("#role").textContent = `${role.name} ▾`;
    document.getElementById(role.section).scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function init() {
    $$("[data-scroll]").forEach((btn) => {
      btn.onclick = () => document.getElementById(btn.dataset.scroll).scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#search").onclick = () => renderProducts($("#q").value);
    $("#q").oninput = debounce((e) => renderProducts(e.target.value), 150);
    $("#close").onclick = closeModal;
    $("#role").onclick = switchRole;
    $("#help").onclick = () => openModal("How NOVA Smart Local works", `
      <p><b>1. Input:</b> customer searches or asks a Community Store.</p>
      <p><b>2. Logic:</b> check availability, reserve stock, predict demand and find backup local fulfillment.</p>
      <p><b>3. Action:</b> store/community/delivery roles update the order.</p>
      <p><b>4. Output:</b> reliable fulfillment, clear tracking and measurable business signals.</p>`);
    $("#prepare").onclick = () => notify("Demand-based stock preparation plan created.");
    $("#maps").onclick = () => {
      countEvent();
      window.open(mapsSearchUrl(STORE_QUERY + " near me"), "_blank", "noopener,noreferrer");
    };
    $("#showMap").onclick = toggleMap;
    $("#calendar").onclick = addCalendarReminder;
    document.addEventListener("click", handleClick);
    renderProducts("");
    renderStockPanel();
    renderTimeline();
  }

  init();
})();
