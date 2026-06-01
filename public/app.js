// ---- tiny helpers ---------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Lock background scroll whenever any full-screen overlay is visible. Watches
// the overlays' class attribute so we don't have to touch every show/hide site.
(() => {
  const overlays = ["#login", "#editor", "#prestart", "#timer"]
    .map((s) => document.querySelector(s))
    .filter(Boolean);
  const sync = () =>
    document.body.classList.toggle(
      "modal-open",
      overlays.some((el) => !el.classList.contains("hidden"))
    );
  const obs = new MutationObserver(sync);
  overlays.forEach((el) => obs.observe(el, { attributes: true, attributeFilter: ["class"] }));
  sync();
})();
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
};
const fmt = (secs) => {
  secs = Math.max(0, Math.round(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};
const parseMMSS = (str) => {
  if (!str) return null;
  if (String(str).includes(":")) {
    const [m, s] = String(str).split(":").map(Number);
    return (m || 0) * 60 + (s || 0);
  }
  return Math.round(Number(str) * 60); // bare number = minutes
};

const state = { role: null, appliances: [], editing: null };

// Brief auto-dismissing status message at the bottom of the screen.
let toastTimer = null;
function toast(message) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast hidden";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// In-app replacement for window.confirm(); resolves true/false.
function confirmDialog(message, { okLabel = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirm-modal");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    $("#confirm-message").textContent = message;
    ok.textContent = okLabel;
    ok.classList.toggle("danger", danger);
    modal.classList.remove("hidden");
    const done = (result) => {
      modal.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}

// ---- auth -----------------------------------------------------------------
async function init() {
  const { role } = await api("/api/me");
  if (role) {
    state.role = role;
    await showApp();
  } else {
    $("#login").classList.remove("hidden");
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { role } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value }),
    });
    state.role = role;
    $("#login").classList.add("hidden");
    await showApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

async function showApp() {
  $("#app").classList.remove("hidden");
  if (state.role === "editor") $("#add-btn").classList.remove("hidden");
  updateAlertsUI();
  state.appliances = await api("/api/appliances");
  await loadFilters();
  await loadEntries();
}

// ---- filters & list -------------------------------------------------------
async function loadFilters() {
  const tags = await api("/api/tags");
  const cats = [...new Set((await api("/api/entries")).map((e) => e.category).filter(Boolean))].sort();
  $("#filter-tag").innerHTML =
    '<option value="">All tags</option>' + tags.map((t) => `<option>${t}</option>`).join("");
  $("#filter-category").innerHTML =
    '<option value="">All categories</option>' + cats.map((c) => `<option>${c}</option>`).join("");
  $("#category-list").innerHTML = cats.map((c) => `<option value="${c}">`).join("");
}

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEntries, 200);
});
$("#filter-category").addEventListener("change", loadEntries);
$("#filter-tag").addEventListener("change", loadEntries);

async function loadEntries() {
  const params = new URLSearchParams();
  if ($("#search").value) params.set("q", $("#search").value);
  if ($("#filter-category").value) params.set("category", $("#filter-category").value);
  if ($("#filter-tag").value) params.set("tag", $("#filter-tag").value);
  const entries = await api("/api/entries?" + params);
  renderList(entries);
}

function renderList(entries) {
  const list = $("#list");
  $("#empty").classList.toggle("hidden", entries.length > 0);
  list.innerHTML = entries.map(card).join("");
  const find = (id) => entries.find((e) => e.id == id);
  // Tapping anywhere on the card (except a button or the menu) opens the detail screen.
  $$(".entry", list).forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target.closest("button") || ev.target.closest(".menu-wrap")) return;
      openPrestart(find(el.dataset.id));
    })
  );
  $$("[data-start]", list).forEach((b) =>
    b.addEventListener("click", () => openPrestart(find(b.dataset.start)))
  );
  $$("[data-menu]", list).forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = list.querySelector(`.menu[data-menu-for="${b.dataset.menu}"]`);
      const wasOpen = !menu.classList.contains("hidden");
      closeAllMenus();
      if (!wasOpen) menu.classList.remove("hidden");
    })
  );
  $$("[data-edit]", list).forEach((b) =>
    b.addEventListener("click", () => { closeAllMenus(); openEditor(find(b.dataset.edit)); })
  );
  $$("[data-del]", list).forEach((b) =>
    b.addEventListener("click", async () => {
      closeAllMenus();
      const entry = find(b.dataset.del);
      const ok = await confirmDialog(`Delete "${entry?.name}"? This can't be undone.`, {
        okLabel: "Delete",
        danger: true,
      });
      if (ok) {
        await api("/api/entries/" + b.dataset.del, { method: "DELETE" });
        loadEntries();
      }
    })
  );
}

function closeAllMenus() {
  document.querySelectorAll("#list .menu").forEach((m) => m.classList.add("hidden"));
}
// Click anywhere else closes any open kebab menu (kebab clicks stopPropagation).
document.addEventListener("click", closeAllMenus);

function card(e) {
  const total = e.total_time_seconds;
  const photo = e.photo_filename
    ? `<div class="photo" style="background-image:url('/uploads/${e.photo_filename}');background-position:${e.focus_x ?? 50}% ${e.focus_y ?? 50}%"></div>`
    : `<div class="photo">🍽️</div>`;
  const menu =
    state.role === "editor"
      ? `<div class="menu-wrap">
           <button class="ghost kebab" data-menu="${e.id}" aria-label="More actions" title="More">⋮</button>
           <div class="menu hidden" data-menu-for="${e.id}">
             <button data-edit="${e.id}">Edit</button>
             <button class="menu-danger" data-del="${e.id}">Delete</button>
           </div>
         </div>`
      : "";
  const actions = `<button class="primary" data-start="${e.id}">Cook</button>${menu}`;
  return `
    <article class="entry" data-id="${e.id}">
      ${photo}
      <div class="body">
        <h3>${esc(e.name)}</h3>
        <div class="meta">
          ${e.brand ? `<span>${esc(e.brand)}</span>` : ""}
          ${e.temp ? `<span class="chip hot">${e.temp}°${e.temp_unit}</span>` : ""}
          ${total ? `<span class="chip hot">${fmt(total)}</span>` : ""}
          ${e.preheat ? `<span class="chip hot">Preheat</span>` : ""}
          ${midpointLabel(e) ? `<span class="chip hot">${midpointLabel(e)}</span>` : ""}
          ${e.rating ? `<span>${"★".repeat(e.rating)}</span>` : ""}
        </div>
        ${e.tags.length ? `<div class="tags">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
        ${e.notes ? `<p class="muted small">${esc(e.notes)}</p>` : ""}
        <div class="actions">${actions}</div>
      </div>
    </article>`;
}

const midpointLabel = (e) => {
  const acts = e.steps.map((s) => s.end_action).filter((a) => a && !["none", "done"].includes(a));
  if (!acts.length) return "";
  return acts[0].charAt(0).toUpperCase() + acts[0].slice(1);
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- editor ---------------------------------------------------------------
$("#add-btn").addEventListener("click", () => openEditor(null));
$("#cancel-edit").addEventListener("click", closeEditor);
$("#add-step").addEventListener("click", () => addStepRow());

function applianceOptions(selected) {
  return state.appliances
    .map((a) => `<option value="${a.id}" ${a.id == selected ? "selected" : ""}>${esc(a.name)}${a.wattage ? ` (${a.wattage}W)` : ""}</option>`)
    .join("");
}

function addStepRow(step = {}) {
  const wrap = document.createElement("div");
  wrap.className = "step-row";
  wrap.innerHTML = `
    <label>Minutes<input class="s-min" type="number" min="0" step="0.5" value="${step.duration_seconds ? step.duration_seconds / 60 : ""}" /></label>
    <label>Then<select class="s-act">
      ${["none", "flip", "shake", "toss", "done", "custom"].map((a) => `<option ${a === step.end_action ? "selected" : ""}>${a}</option>`).join("")}
    </select></label>
    <label>Temp°<input class="s-temp" type="number" placeholder="—" value="${step.temp_override ?? ""}" /></label>
    <button type="button" class="ghost small del">✕</button>`;
  wrap.querySelector(".del").addEventListener("click", () => wrap.remove());
  $("#steps").appendChild(wrap);
}

function openEditor(entry) {
  state.editing = entry;
  const f = $("#entry-form");
  f.reset();
  $("#editor-title").textContent = entry ? "Edit entry" : "Add entry";
  $("#editor-error").textContent = "";
  $("#appliance-select").innerHTML =
    `<option value="">—</option>` + applianceOptions(entry?.appliance_id);
  $("#steps").innerHTML = "";
  f.name.value = entry?.name || "";
  f.brand.value = entry?.brand || "";
  f.category.value = entry?.category || "";
  f.temp.value = entry?.temp ?? "";
  f.temp_unit.value = entry?.temp_unit || "F";
  f.servings_note.value = entry?.servings_note || "";
  f.preheat.checked = !!entry?.preheat;
  f.preheat_time.value = entry?.preheat_time_seconds ? fmt(entry.preheat_time_seconds) : "";
  f.rating.value = entry?.rating || 0;
  f.tags.value = (entry?.tags || []).join(", ");
  f.notes.value = entry?.notes || "";
  (entry?.steps?.length ? entry.steps : [{ end_action: "done" }]).forEach(addStepRow);

  // Photo: show the existing one (if any); reset the picker + removal flag.
  editorPhotoRemoved = false;
  editorFocus = { x: entry?.focus_x ?? 50, y: entry?.focus_y ?? 50 };
  $("#photo-input").value = "";
  showPhotoPreview(entry?.photo_filename ? `/uploads/${entry.photo_filename}` : null);

  $("#editor").classList.remove("hidden");
}

let editorPhotoRemoved = false;
let editorFocus = { x: 50, y: 50 }; // focal point % for the card crop

function applyCropPosition() {
  $("#crop-frame").style.backgroundPosition = `${editorFocus.x}% ${editorFocus.y}%`;
}

function showPhotoPreview(src) {
  const wrap = $("#photo-preview");
  const frame = $("#crop-frame");
  if (src) {
    frame.style.backgroundImage = `url('${src}')`;
    applyCropPosition();
    wrap.classList.remove("hidden");
  } else {
    frame.style.backgroundImage = "";
    wrap.classList.add("hidden");
  }
  $("#photo-btn").textContent = src ? "Change photo…" : "Choose photo…";
}

$("#photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  editorPhotoRemoved = false;
  if (file) editorFocus = { x: 50, y: 50 }; // new image starts centered
  showPhotoPreview(file ? URL.createObjectURL(file) : null);
});

$("#photo-remove").addEventListener("click", () => {
  $("#photo-input").value = "";
  editorPhotoRemoved = true; // tells save() to clear an existing photo
  showPhotoPreview(null);
});

$("#crop-reset").addEventListener("click", () => {
  editorFocus = { x: 50, y: 50 };
  applyCropPosition();
});

// Drag within the frame to reposition the focal point. Dragging the photo down
// reveals more of its top (focus_y → 0), etc. Sensitivity is relative to frame size.
(() => {
  const frame = $("#crop-frame");
  let dragging = false, lastX = 0, lastY = 0;
  frame.addEventListener("pointerdown", (e) => {
    if (!frame.style.backgroundImage) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = frame.getBoundingClientRect();
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    // 1.5× gain so a partial drag can sweep the whole range comfortably.
    editorFocus.x = Math.max(0, Math.min(100, editorFocus.x - (dx / rect.width) * 100 * 1.5));
    editorFocus.y = Math.max(0, Math.min(100, editorFocus.y - (dy / rect.height) * 100 * 1.5));
    applyCropPosition();
  });
  const end = (e) => { dragging = false; try { frame.releasePointerCapture(e.pointerId); } catch {} };
  frame.addEventListener("pointerup", end);
  frame.addEventListener("pointercancel", end);
})();

// Downscale large photos in the browser so uploads stay small and fast.
async function resizeImage(file, max = 1280, quality = 0.82) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file; // fall back to the raw file if the browser can't process it
  }
}

function closeEditor() {
  $("#editor").classList.add("hidden");
  state.editing = null;
}

$("#entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const steps = $$(".step-row", $("#steps")).map((row, i, arr) => ({
    duration_seconds: Math.round((Number(row.querySelector(".s-min").value) || 0) * 60),
    end_action: row.querySelector(".s-act").value || (i === arr.length - 1 ? "done" : "none"),
    temp_override: row.querySelector(".s-temp").value || null,
  }));
  const body = {
    name: f.name.value,
    brand: f.brand.value,
    category: f.category.value,
    temp: f.temp.value,
    temp_unit: f.temp_unit.value,
    servings_note: f.servings_note.value,
    preheat: f.preheat.checked,
    preheat_time_seconds: parseMMSS(f.preheat_time.value),
    rating: Number(f.rating.value),
    appliance_id: $("#appliance-select").value,
    tags: f.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
    notes: f.notes.value,
    focus_x: editorFocus.x,
    focus_y: editorFocus.y,
    steps,
  };
  try {
    const saved = state.editing
      ? await api("/api/entries/" + state.editing.id, { method: "PUT", body: JSON.stringify(body) })
      : await api("/api/entries", { method: "POST", body: JSON.stringify(body) });

    // Photo is uploaded separately (needs the entry id). FormData sets its own
    // Content-Type, so we use fetch directly rather than the JSON api() helper.
    const file = $("#photo-input").files[0];
    if (file) {
      const blob = await resizeImage(file);
      const fd = new FormData();
      fd.append("photo", blob, "photo.jpg");
      await fetch("/api/entries/" + saved.id + "/photo", { method: "POST", body: fd });
    } else if (editorPhotoRemoved && state.editing) {
      await api("/api/entries/" + saved.id + "/photo", { method: "DELETE" });
    }

    closeEditor();
    await loadFilters();
    await loadEntries();
  } catch (err) {
    $("#editor-error").textContent = err.message;
  }
});

// ---- timer ----------------------------------------------------------------
// Builds a flat list of phases the countdown walks through, each with an
// alert to fire when it ends. Preheat (if set) becomes the first phase.
function timerSpec(e) {
  const phases = [];
  if (e.preheat && e.preheat_time_seconds) {
    phases.push({ seconds: e.preheat_time_seconds, label: "Preheating", action: "preheat-done" });
  }
  const steps = e.steps?.length ? e.steps : [{ duration_seconds: e.total_time_seconds || 0, end_action: "done" }];
  steps.forEach((s, i) => {
    phases.push({
      seconds: s.duration_seconds,
      label: i === 0 ? "Cooking" : "Cooking",
      action: s.end_action === "none" ? (i === steps.length - 1 ? "done" : "next") : s.end_action,
    });
  });
  return { id: e.id, name: e.name, phases };
}

// ---- pre-start detail / confirmation screen -------------------------------
let prestartSpec = null;
let prestartEntry = null;

function flagPill(label, on, detail) {
  const text = on ? `${label}${detail ? " " + detail : ""}` : `No ${label.toLowerCase()}`;
  return `<span class="ps-flag ${on ? "on" : "off"}">${text}</span>`;
}

// Step-by-step lines, aligned 1:1 with the timer's phases (preheat first, if any).
function breakdownItems(entry) {
  const items = [];
  if (entry.preheat && entry.preheat_time_seconds)
    items.push(
      `<b>Preheat</b> ${fmt(entry.preheat_time_seconds)}${entry.temp ? ` at ${entry.temp}°${entry.temp_unit}` : ""}, then add food`
    );
  const steps = entry.steps?.length
    ? entry.steps
    : [{ duration_seconds: entry.total_time_seconds || 0, end_action: "done" }];
  steps.forEach((s, i) => {
    const temp = s.temp_override ? ` at ${s.temp_override}°` : "";
    let act = "";
    if (["flip", "shake", "toss", "custom"].includes(s.end_action)) {
      const word = s.end_action === "custom" ? s.action_note || "Check it" : ACTION_TEXT[s.end_action];
      act = ` → <b>${esc(word)}</b>`;
    } else if (i === steps.length - 1) {
      act = ` → <b>Done</b>`;
    }
    items.push(`Cook <b>${fmt(s.duration_seconds)}</b>${temp}${act}`);
  });
  return items;
}

function openPrestart(entry) {
  if (!entry) return;
  prestartSpec = timerSpec(entry);
  prestartEntry = entry;

  $("#ps-name").textContent = entry.name;
  const photo = $("#ps-photo");
  if (entry.photo_filename) {
    photo.style.backgroundImage = `url('/uploads/${entry.photo_filename}')`;
    photo.style.backgroundPosition = `${entry.focus_x ?? 50}% ${entry.focus_y ?? 50}%`;
    photo.textContent = "";
  } else {
    photo.style.backgroundImage = "";
    photo.textContent = "🍽️";
  }

  const meta = [];
  if (entry.brand) meta.push(esc(entry.brand));
  if (entry.temp) meta.push(`${entry.temp}°${entry.temp_unit}`);
  if (entry.total_time_seconds) meta.push(`${fmt(entry.total_time_seconds)} total`);
  if (entry.appliance_name) meta.push(esc(entry.appliance_name));
  if (entry.servings_note) meta.push(esc(entry.servings_note));
  $("#ps-meta").innerHTML = meta.map((m) => `<span class="chip">${m}</span>`).join("");

  // Reassurance row — enabled flags first, then the rest in canonical order.
  const acts = (entry.steps || []).map((s) => s.end_action);
  const hasPreheat = !!(entry.preheat && entry.preheat_time_seconds);
  const flags = [
    { label: "Preheat", on: hasPreheat, detail: hasPreheat ? fmt(entry.preheat_time_seconds) : "" },
    { label: "Flip", on: acts.includes("flip") },
    { label: "Shake", on: acts.includes("shake") },
  ];
  if (acts.includes("toss")) flags.push({ label: "Toss", on: true });
  flags.sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0)); // stable: enabled first
  $("#ps-flags").innerHTML = flags.map((f) => flagPill(f.label, f.on, f.detail)).join("");

  // Step-by-step breakdown (shared with the running timer), plus a lead-in
  // instruction shown ONLY here — it's guidance, not an actual timer phase.
  const stepItems = breakdownItems(entry).map((h) => `<li>${h}</li>`);
  if (!hasPreheat) {
    const tempPart = entry.temp ? `set to <b>${entry.temp}°${entry.temp_unit}</b>, ` : "";
    stepItems.unshift(`<li>Add food, ${tempPart}then press Start Cook Timer</li>`);
  }
  $("#ps-steps").innerHTML = stepItems.join("");

  $("#ps-notes").textContent = entry.notes || "";
  $("#ps-notes").classList.toggle("hidden", !entry.notes);

  $("#prestart").classList.remove("hidden");
}

function closePrestart() {
  $("#prestart").classList.add("hidden");
  prestartSpec = null;
  prestartEntry = null;
}

$("#ps-cancel").addEventListener("click", closePrestart);
$("#ps-close").addEventListener("click", closePrestart);
$("#ps-start").addEventListener("click", () => {
  const spec = prestartSpec, entry = prestartEntry;
  closePrestart();
  if (spec) startTimer(spec, entry); // this click is the gesture that unlocks audio
});

let timer = null;
let audioCtx = null;

function beep(times = 1, freq = 880, dur = 0.18) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain).connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t);
      osc.stop(t + dur);
      t += dur + 0.12;
    }
  } catch {}
}
const vibrate = (p) => navigator.vibrate?.(p);

const ACTION_TEXT = {
  flip: "Flip it!",
  shake: "Shake it!",
  toss: "Toss it!",
  custom: "Check it!",
  "preheat-done": "Preheated — add food!",
  done: "Done!",
};

// ---- background push alerts (server-armed) --------------------------------
// The server fires a single pending push per device when a countdown segment
// ends WHILE the app is backgrounded/closed. When foreground, the in-app alarm
// fires first and we disarm, so a grace offset prevents a duplicate push.
const ALERT_GRACE_S = 3;

// From the current phase, sum time until the next end that actually alerts —
// skipping seamless "next" transitions (e.g. a mid-cook temp bump). Returns the
// seconds-from-now and the action, or null if nothing left alerts.
function nextAlert() {
  if (!timer) return null;
  let i = timer.idx;
  let secs = timer.remaining;
  while (i < timer.spec.phases.length) {
    const action = timer.spec.phases[i].action;
    if (action !== "next") return { fireInSeconds: secs, action };
    i += 1;
    if (i < timer.spec.phases.length) secs += timer.spec.phases[i].seconds;
  }
  return null;
}

async function armServerAlert() {
  if (!pushEndpoint || !timer) return;
  const next = nextAlert();
  if (!next) return disarmServerAlert();
  try {
    await api("/api/timer/arm", {
      method: "POST",
      body: JSON.stringify({
        endpoint: pushEndpoint,
        fireInSeconds: Math.max(1, next.fireInSeconds + ALERT_GRACE_S),
        title: timer.spec.name,
        body: ACTION_TEXT[next.action] || "Check it!",
      }),
    });
  } catch {}
}

async function disarmServerAlert() {
  if (!pushEndpoint) return;
  try {
    await api("/api/timer/disarm", { method: "POST", body: JSON.stringify({ endpoint: pushEndpoint }) });
  } catch {}
}

// Arm when a countdown is actively running; disarm when paused/held/finished.
function syncServerAlert() {
  if (!timer || timer.finished || timer.paused || timer.awaiting) disarmServerAlert();
  else armServerAlert();
}

// Set the current running segment's length and its wall-clock end (so the
// countdown stays accurate across backgrounding/throttling).
function setSegment(seconds) {
  timer.remaining = seconds;
  timer.segmentEndsAt = Date.now() + seconds * 1000;
}

async function startTimer(spec, entry) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}

  timer = { spec, idx: 0, remaining: spec.phases[0]?.seconds || 0, paused: false, awaiting: null, finished: false, wakeLock };
  setSegment(timer.remaining);
  $("#timer-steps").innerHTML = entry
    ? breakdownItems(entry).map((h, i) => `<li data-phase="${i}">${h}</li>`).join("")
    : "";
  $("#timer-name").textContent = spec.name;
  $("#timer").classList.remove("hidden");
  renderTimer();

  timer.interval = setInterval(tick, 1000);
  syncServerAlert();
}

const currentPhase = () => timer.spec.phases[timer.idx];

// "Step 2 of 3" across the cooking phases (preheat excluded).
function stepProgress() {
  const cook = timer.spec.phases.filter((ph) => ph.label === "Cooking");
  const cur = currentPhase();
  if (cur?.label === "Preheating") return "Preheating";
  const n = cook.indexOf(cur) + 1;
  return cook.length > 1 ? `Step ${n} of ${cook.length}` : "";
}

// Orange-highlight the step the timer is currently on (none once finished).
function highlightStep() {
  document.querySelectorAll("#timer-steps li").forEach((li) =>
    li.classList.toggle("current", !timer.finished && Number(li.dataset.phase) === timer.idx)
  );
}

function renderTimer() {
  highlightStep();
  const pauseBtn = $("#timer-pause");

  if (timer.finished) {
    $("#timer-stage").textContent = "Done!";
    $("#timer-clock").textContent = "0:00";
    $("#timer-next").textContent = "Take it out 🎉";
    pauseBtn.classList.add("hidden");
    return;
  }

  // Held at a flip/shake/toss/preheat boundary: the instruction shows ONLY here,
  // and the countdown waits until the user taps Resume.
  if (timer.awaiting) {
    $("#timer-stage").textContent = ACTION_TEXT[timer.awaiting] || "Check it!";
    $("#timer-clock").textContent = fmt(timer.remaining);
    $("#timer-next").textContent =
      timer.awaiting === "preheat-done"
        ? "Add food, then tap Resume"
        : "Tap Resume when you're done";
    pauseBtn.textContent = "Resume";
    pauseBtn.classList.remove("hidden");
    return;
  }

  const p = currentPhase();
  $("#timer-stage").textContent = p?.label || "Cooking";
  $("#timer-clock").textContent = fmt(timer.remaining);
  $("#timer-next").textContent = stepProgress();
  pauseBtn.textContent = timer.paused ? "Resume" : "Pause";
  pauseBtn.classList.remove("hidden");
}

function tick() {
  if (timer.paused || timer.finished) return;
  // Wall-clock based so a backgrounded/throttled tab stays accurate on return.
  timer.remaining = Math.ceil((timer.segmentEndsAt - Date.now()) / 1000);
  if (timer.remaining <= 0) {
    timer.remaining = 0;
    advancePhase();
  } else renderTimer();
}

// Fire the end-of-phase alert, then advance. Interactive actions
// (flip/shake/toss/custom/preheat) HOLD the countdown until the user resumes —
// so "Shake it!" appears at the transition, never during the step.
function advancePhase() {
  const action = currentPhase().action;
  startAlarm(action);
  timer.idx += 1;
  if (timer.idx >= timer.spec.phases.length) {
    timer.finished = true;
    timer.paused = true;
    renderTimer();
    syncServerAlert(); // finished → disarm (the in-app "Done!" alarm handled it)
    return;
  }
  setSegment(currentPhase().seconds);
  if (["flip", "shake", "toss", "custom", "preheat-done"].includes(action)) {
    timer.paused = true;
    timer.awaiting = action;
  }
  renderTimer();
  syncServerAlert(); // arm the next real alert, or disarm if now holding
}

// Ring (and flash) repeatedly every 5s until acknowledged — Resume for an
// interactive hold, Stop for the final "Done" alarm.
const ALARM_INTERVAL_MS = 5000;

function startAlarm(action) {
  if (action === "next") return; // seamless step change (e.g. temp bump), no alert
  stopAlarm();
  $("#timer").classList.add("alerting");
  const ring =
    action === "done"
      ? () => { beep(4, 660, 0.3); vibrate([300, 150, 300, 150, 500]); }
      : () => { beep(2, 990); vibrate([200, 100, 200]); };
  ring(); // fire immediately, then repeat
  timer.alarmInterval = setInterval(ring, ALARM_INTERVAL_MS);
}

function stopAlarm() {
  if (timer?.alarmInterval) {
    clearInterval(timer.alarmInterval);
    timer.alarmInterval = null;
  }
  $("#timer").classList.remove("alerting");
}

$("#timer-pause").addEventListener("click", () => {
  if (timer.finished) return;
  if (timer.awaiting) {
    timer.awaiting = null;
    timer.paused = false;
    setSegment(timer.remaining); // restart wall-clock for the resumed segment
    stopAlarm();
  } else {
    timer.paused = !timer.paused;
    if (!timer.paused) setSegment(timer.remaining);
  }
  renderTimer();
  syncServerAlert();
});
$("#timer-add30").addEventListener("click", () => {
  if (timer.finished) return;
  timer.remaining += 30;
  timer.segmentEndsAt += 30000;
  renderTimer();
  syncServerAlert(); // re-arm with the extended time
});
$("#timer-stop").addEventListener("click", async () => {
  // Confirm only while actively cooking/holding — on the "Done!" screen, Stop
  // just dismisses (and silences the done alarm), so no prompt needed there.
  if (timer && !timer.finished) {
    const ok = await confirmDialog("Stop the timer? This resets all steps and timers.", {
      okLabel: "Stop timer",
      danger: true,
    });
    if (!ok) return;
  }
  if (timer) stopTimer();
});

async function stopTimer() {
  clearInterval(timer.interval);
  stopAlarm();
  disarmServerAlert(); // cancel any pending background push
  try { await timer.wakeLock?.release(); } catch {}
  $("#timer").classList.add("hidden");
  // Stamp "last cooked" for the entry we just finished.
  if (timer.spec.id) api("/api/entries/" + timer.spec.id + "/cooked", { method: "POST" }).then(loadEntries).catch(() => {});
  timer = null;
}

// Returning to a backgrounded app: recompute the countdown immediately so the
// display reflects reality (and advances/finishes if time elapsed while away).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && timer && !timer.paused && !timer.finished) tick();
});

// ---- Push notifications ---------------------------------------------------
let swReg = null;
let pushEndpoint = null; // this device's subscription endpoint (target for timer pushes)
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Register the SW and, if the user already granted permission, refresh the
// server-side subscription so it stays current.
async function initPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    return;
  }
  if (pushSupported && Notification.permission === "granted") {
    await subscribePush().catch(() => {});
  }
  updateAlertsUI();
}

// Ask permission (if needed), subscribe via PushManager, send to server.
async function subscribePush() {
  if (!pushSupported) throw new Error("unsupported");
  swReg = await navigator.serviceWorker.ready; // ensure an ACTIVE worker before subscribing
  const { enabled, publicKey } = await api("/api/push/key");
  if (!enabled || !publicKey) throw new Error("Push not configured on the server.");
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notification permission denied.");
  }
  const sub =
    (await swReg.pushManager.getSubscription()) ||
    (await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  pushEndpoint = sub.endpoint; // enables server-armed timer alerts for this device
  return sub;
}

function updateAlertsUI() {
  const btn = $("#alerts-btn");
  if (!btn) return;
  if (!pushSupported) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const granted = Notification.permission === "granted";
  btn.textContent = granted ? "Test Alert" : "Enable Alerts";
  btn.dataset.state = granted ? "ready" : "enable";
}

async function onAlertsClick() {
  const btn = $("#alerts-btn");
  try {
    if (btn.dataset.state !== "ready") {
      await subscribePush();
      updateAlertsUI();
      toast("Alerts enabled. Sending a test…");
    }
    const r = await api("/api/push/test", { method: "POST" });
    if (r.sent) {
      toast("Test alert sent — check your notifications.");
    } else if (r.errors?.length) {
      const e = r.errors[0];
      toast(`Push failed (${e.statusCode || "?"}): ${e.body || "see server logs"}`);
    } else if (r.total === 0) {
      toast("No subscription on server. Tap Enable Alerts again.");
    } else {
      toast("Push not delivered. Check server logs.");
    }
  } catch (e) {
    toast(e.message || "Couldn't enable alerts.");
  }
}

$("#alerts-btn")?.addEventListener("click", onAlertsClick);

initPush();
init();
