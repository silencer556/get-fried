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
  closeAllMenus();
  if (!(await confirmDialog("Sign out?", { okLabel: "Sign out" }))) return;
  await api("/api/logout", { method: "POST" });
  location.reload();
});

// ---- Backup: export / import ----------------------------------------------
const dataModal = $("#data-modal");
const hideDataModal = () => dataModal.classList.add("hidden");

$("#data-btn").addEventListener("click", () => {
  closeAllMenus();
  dataModal.classList.remove("hidden");
});
$("#data-cancel").addEventListener("click", hideDataModal);
dataModal.addEventListener("click", (e) => {
  if (e.target === dataModal) hideDataModal(); // tap backdrop to dismiss
});

$("#data-export").addEventListener("click", () => {
  hideDataModal();
  // Same-origin GET sends the auth cookie; Content-Disposition triggers download.
  window.location.href = "/api/export";
});

$("#data-import").addEventListener("click", () => {
  hideDataModal();
  $("#import-file").value = ""; // allow re-picking the same file
  $("#import-file").click();
});

$("#import-file").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file isn't valid JSON.");
  }
  const entries = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(entries) || !entries.length)
    return toast("No entries found in that file.");
  if (
    !(await confirmDialog(
      `Import ${entries.length} entr${entries.length === 1 ? "y" : "ies"}? ` +
        `Entries whose name you already have are skipped. Photos aren't included.`,
      { okLabel: "Import" }
    ))
  )
    return;
  try {
    const r = await api("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    toast(`Imported ${r.created} • skipped ${r.skipped}.`);
    await loadFilters();
    await loadEntries();
  } catch (err) {
    toast("Import failed: " + err.message);
  }
});

async function showApp() {
  $("#app").classList.remove("hidden");
  if (state.role === "editor") {
    $("#add-btn").classList.remove("hidden");
    document.querySelectorAll(".editor-only").forEach((el) => el.classList.remove("hidden"));
  }
  updateAlertsUI();
  restoreActiveCooks(); // re-attach to cooks left running when the app was closed
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
  document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
}
// Click anywhere else closes any open kebab menu (kebab clicks stopPropagation).
document.addEventListener("click", closeAllMenus);

// Header kebab (holds Alerts + Sign out).
$("#header-kebab")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const m = $("#header-menu");
  const wasOpen = !m.classList.contains("hidden");
  closeAllMenus();
  if (!wasOpen) m.classList.remove("hidden");
});

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

// Inline SVG arrow — drawn, not a font glyph, so it aligns identically on every
// platform (the → character sits low in Android's default font).
const ARROW = `<svg class="arr" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h10M9.5 4.5 13 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
      act = ` ${ARROW} <b>${esc(word)}</b>`;
    } else if (i === steps.length - 1) {
      act = ` ${ARROW} <b>Done</b>`;
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
    stepItems.unshift(`<li>Add food, ${tempPart}then press Start</li>`);
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
// Tap the backdrop (outside the card) to dismiss, same as Cancel.
$("#prestart").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closePrestart();
});
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
// The server fires the alert push at a segment's end so it lands even when the
// app is backgrounded/locked/closed. The push ALWAYS fires (no foreground
// suppression) — when foreground you also get the in-app alarm, which is fine.
// We re-arm at each segment start; alerts are always followed by a hold or are
// the final "done", so a new arm never cancels an about-to-fire one.

// Make sure we have this device's subscription endpoint (needed to target the
// push). Falls back to reading the existing subscription if it wasn't cached.
async function ensurePushEndpoint() {
  if (pushEndpoint) return pushEndpoint;
  if (!pushSupported || Notification.permission !== "granted") return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      pushEndpoint = sub.endpoint;
      // make sure the server knows this subscription
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) }).catch(() => {});
    }
  } catch {}
  return pushEndpoint;
}

// ---- multiple concurrent cooks --------------------------------------------
// `timers` holds every live cook (e.g. two air fryers going). `timer` is the
// one currently shown in the full overlay (or null when all are minimized).
// Each cook has a unique id; pushes and persisted state are keyed by that id.
let timers = [];
const MAX_COOKS = 3;
let tickInterval = null;

function ensureTickLoop() {
  if (!tickInterval) tickInterval = setInterval(() => timers.slice().forEach(tickOne), 1000);
}
function stopTickLoopIfIdle() {
  if (!timers.length && tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
async function resumeAudio() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  try { if (audioCtx.state === "suspended") await audioCtx.resume(); } catch {}
}

// From a cook's current phase, sum time until the next end that actually alerts —
// skipping seamless "next" transitions. Returns seconds-from-now + action, or null.
function nextAlert(t) {
  let i = t.idx;
  let secs = t.remaining;
  while (i < t.spec.phases.length) {
    const action = t.spec.phases[i].action;
    if (action !== "next") return { fireInSeconds: secs, action };
    i += 1;
    if (i < t.spec.phases.length) secs += t.spec.phases[i].seconds;
  }
  return null;
}

// Arm the server push for this cook's upcoming alert. Returns true if armed.
async function armServerAlert(t) {
  const endpoint = await ensurePushEndpoint();
  if (!endpoint) return false;
  const next = nextAlert(t);
  if (!next) {
    disarmServerAlert(t);
    return false;
  }
  try {
    await api("/api/timer/arm", {
      method: "POST",
      body: JSON.stringify({
        cookId: t.id,
        endpoint,
        fireInSeconds: Math.max(1, next.fireInSeconds),
        title: t.spec.name,
        body: ACTION_TEXT[next.action] || "Check it!",
      }),
    });
    return true;
  } catch {
    return false;
  }
}

async function disarmServerAlert(t) {
  try {
    await api("/api/timer/disarm", { method: "POST", body: JSON.stringify({ cookId: t.id }) });
  } catch {}
}

// Set a cook's running segment length + wall-clock end (accurate across backgrounding).
function setSegment(t, seconds) {
  t.remaining = seconds;
  t.segmentEndsAt = Date.now() + seconds * 1000;
}

// ---- floating pills (one per minimized cook) ------------------------------
function pillLabel(t) {
  if (t.finished) return "Done!";
  if (t.awaiting) return ACTION_TEXT[t.awaiting] || "Check it!";
  if (t.paused) return "Paused";
  return fmt(t.remaining);
}
function updatePill(t) {
  const el = document.querySelector(`#cook-pills [data-cook-id="${t.id}"]`);
  if (!el) return;
  el.innerHTML = `<span class="pill-name">${esc(t.spec.name)}</span> <span class="pill-clock">${esc(pillLabel(t))}</span>`;
  el.classList.toggle("alerting", !!(t.awaiting || t.finished || t.alarming));
}
// Sync the pill row to `timers` (the open cook shows in the overlay, not as a pill).
function renderPills() {
  const container = $("#cook-pills");
  const visible = timers.filter((t) => t !== timer);
  const ids = new Set(visible.map((t) => t.id));
  [...container.children].forEach((el) => { if (!ids.has(el.dataset.cookId)) el.remove(); });
  visible.forEach((t) => {
    let el = container.querySelector(`[data-cook-id="${t.id}"]`);
    if (!el) {
      el = document.createElement("button");
      el.className = "cook-pill";
      el.dataset.cookId = t.id;
      el.addEventListener("click", () => openCook(t.id));
      container.appendChild(el);
    }
    updatePill(t);
  });
  container.classList.toggle("hidden", visible.length === 0);
}
// Show a cook in the full-screen overlay.
function openCook(id) {
  const t = timers.find((x) => x.id === id);
  if (!t) return;
  timer = t;
  $("#timer-name").textContent = t.spec.name;
  $("#timer-steps").innerHTML = t.stepsHtml || "";
  $("#timer").classList.toggle("alerting", !!t.alarming);
  $("#timer").classList.remove("hidden");
  resumeAudio();
  renderPills();
  renderTimer(t);
}
// Collapse the open cook back to a pill.
function minimizeActive() {
  if (!timer) return;
  $("#timer").classList.add("hidden");
  $("#timer").classList.remove("alerting");
  timer = null;
  renderPills();
}

// ---- active-cook persistence (survive close / restart) --------------------
function deviceId() {
  let id = localStorage.getItem("gf-device");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    localStorage.setItem("gf-device", id);
  }
  return id;
}

function cookState(t) {
  return {
    deviceId: deviceId(),
    cookId: t.id,
    entryId: t.spec.id,
    name: t.spec.name,
    phases: t.spec.phases,
    stepsHtml: t.stepsHtml,
    idx: t.idx,
    paused: t.paused,
    awaiting: t.awaiting,
    finished: t.finished,
    segmentEndsAt: t.segmentEndsAt || null,
    remaining: t.remaining,
    savedAt: Date.now(),
  };
}
async function persistCook(t) {
  try { await api("/api/cook/state", { method: "PUT", body: JSON.stringify(cookState(t)) }); } catch {}
}
async function deleteCookState(id) {
  try { await api("/api/cook/state?cookId=" + encodeURIComponent(id), { method: "DELETE" }); } catch {}
}

// On load, re-attach to ALL cooks that were running when the app closed/restarted.
async function restoreActiveCooks() {
  if (timers.length) return;
  let list;
  try { list = await api("/api/cook/state?deviceId=" + encodeURIComponent(deviceId())); } catch { return; }
  if (!Array.isArray(list)) return;
  for (const s of list) {
    if (!s.phases) continue;
    if (s.savedAt && Date.now() - s.savedAt > 6 * 3600 * 1000) { deleteCookState(s.cookId); continue; }
    const t = {
      id: s.cookId,
      spec: { id: s.entryId, name: s.name, phases: s.phases },
      idx: s.idx, paused: s.paused, awaiting: s.awaiting, finished: s.finished,
      wakeLock: null, stepsHtml: s.stepsHtml || "",
    };
    if (!s.finished && !s.paused && !s.awaiting && s.segmentEndsAt) {
      t.segmentEndsAt = s.segmentEndsAt;
      t.remaining = Math.max(0, Math.ceil((s.segmentEndsAt - Date.now()) / 1000));
    } else {
      t.remaining = s.remaining || 0;
      t.segmentEndsAt = Date.now() + (s.remaining || 0) * 1000;
    }
    timers.push(t);
  }
  if (!timers.length) return;
  ensureTickLoop();
  renderPills(); // restore as pills (non-intrusive; nothing auto-opens)
  timers.slice().forEach((t) => { if (!t.paused && !t.finished) tickOne(t); }); // reconcile elapsed time
}

async function startTimer(spec, entry) {
  if (timers.length >= MAX_COOKS) {
    toast(`You can run up to ${MAX_COOKS} cooks at once — stop one first.`);
    return;
  }
  await resumeAudio();
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}

  const t = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2),
    spec, idx: 0, paused: false, awaiting: null, finished: false, alarming: false, wakeLock,
    stepsHtml: entry
      ? breakdownItems(entry).map((h, i) => `<li data-phase="${i}">${h}</li>`).join("")
      : "",
  };
  setSegment(t, spec.phases[0]?.seconds || 0);
  timers.push(t);
  ensureTickLoop();
  openCook(t.id); // show the new cook
  persistCook(t);
  armServerAlert(t).then((armed) => {
    if (!timers.includes(t)) return; // stopped already
    if (!armed && pushSupported && Notification.permission !== "granted")
      toast("Tip: tap the ⋮ menu → Enable Alerts for background notifications.");
  });
}

$("#timer-min").addEventListener("click", minimizeActive);

const currentPhase = (t) => t.spec.phases[t.idx];

// "Step 2 of 3" across the cooking phases (preheat excluded).
function stepProgress(t) {
  const cook = t.spec.phases.filter((ph) => ph.label === "Cooking");
  const cur = currentPhase(t);
  if (cur?.label === "Preheating") return "Preheating";
  const n = cook.indexOf(cur) + 1;
  return cook.length > 1 ? `Step ${n} of ${cook.length}` : "";
}

// Orange-highlight the step the open cook is currently on (none once finished).
function highlightStep(t) {
  document.querySelectorAll("#timer-steps li").forEach((li) =>
    li.classList.toggle("current", !t.finished && Number(li.dataset.phase) === t.idx)
  );
}

// Update a cook's pill always; update the overlay only when it's the open cook.
function renderTimer(t) {
  updatePill(t);
  if (t !== timer) return;

  highlightStep(t);
  const pauseBtn = $("#timer-pause");

  if (t.finished) {
    $("#timer-stage").textContent = "Done!";
    $("#timer-clock").textContent = "0:00";
    $("#timer-next").textContent = "Take it out 🎉";
    pauseBtn.classList.add("hidden");
    return;
  }

  // Held at a flip/shake/toss/preheat boundary: instruction shows here, countdown waits.
  if (t.awaiting) {
    $("#timer-stage").textContent = ACTION_TEXT[t.awaiting] || "Check it!";
    $("#timer-clock").textContent = fmt(t.remaining);
    $("#timer-next").textContent =
      t.awaiting === "preheat-done" ? "Add food, then tap Resume" : "Tap Resume when you're done";
    pauseBtn.textContent = "Resume";
    pauseBtn.classList.remove("hidden");
    return;
  }

  const p = currentPhase(t);
  $("#timer-stage").textContent = p?.label || "Cooking";
  $("#timer-clock").textContent = fmt(t.remaining);
  $("#timer-next").textContent = stepProgress(t);
  pauseBtn.textContent = t.paused ? "Resume" : "Pause";
  pauseBtn.classList.remove("hidden");
}

function tickOne(t) {
  if (t.paused || t.finished) return;
  // Wall-clock based so a backgrounded/throttled tab stays accurate on return.
  t.remaining = Math.ceil((t.segmentEndsAt - Date.now()) / 1000);
  if (t.remaining <= 0) {
    t.remaining = 0;
    advancePhase(t);
  } else renderTimer(t);
}

// Fire the end-of-phase alert, then advance. Interactive actions hold until Resume.
function advancePhase(t) {
  const action = currentPhase(t).action;
  startAlarm(t, action);
  if (["flip", "shake", "toss", "custom", "preheat-done"].includes(action)) {
    t.paused = true;
    t.awaiting = action;
    t.remaining = 0;
    renderTimer(t);
    persistCook(t);
    return;
  }
  // Seamless ("next") or final ("done"): advance immediately.
  t.idx += 1;
  if (t.idx >= t.spec.phases.length) {
    t.finished = true;
    t.paused = true;
    renderTimer(t);
    persistCook(t);
    return; // the armed "Done!" push fires on its own
  }
  setSegment(t, currentPhase(t).seconds);
  renderTimer(t);
  persistCook(t);
}

// Ring (and flash) repeatedly every 5s until acknowledged.
const ALARM_INTERVAL_MS = 5000;

function startAlarm(t, action) {
  if (action === "next") return; // seamless step change, no alert
  stopAlarm(t);
  t.alarming = true;
  if (t === timer) $("#timer").classList.add("alerting");
  const ring =
    action === "done"
      ? () => { beep(4, 660, 0.3); vibrate([300, 150, 300, 150, 500]); }
      : () => { beep(2, 990); vibrate([200, 100, 200]); };
  ring(); // fire immediately, then repeat
  t.alarmInterval = setInterval(ring, ALARM_INTERVAL_MS);
  updatePill(t);
}

function stopAlarm(t) {
  if (t?.alarmInterval) {
    clearInterval(t.alarmInterval);
    t.alarmInterval = null;
  }
  if (t) t.alarming = false;
  if (t === timer) $("#timer").classList.remove("alerting");
}

$("#timer-pause").addEventListener("click", () => {
  const t = timer;
  if (!t || t.finished) return;
  if (t.awaiting) {
    // Acknowledge the hold and NOW advance to the next step.
    t.awaiting = null;
    t.paused = false;
    stopAlarm(t);
    t.idx += 1;
    if (t.idx >= t.spec.phases.length) {
      t.finished = true;
      t.paused = true;
      renderTimer(t);
      persistCook(t);
      return; // (guard; holds are never the last phase in practice)
    }
    setSegment(t, currentPhase(t).seconds);
    armServerAlert(t);
  } else {
    t.paused = !t.paused;
    if (!t.paused) {
      setSegment(t, t.remaining);
      armServerAlert(t);
    } else {
      disarmServerAlert(t);
    }
  }
  renderTimer(t);
  persistCook(t);
});

$("#timer-add30").addEventListener("click", () => {
  const t = timer;
  if (!t) return;
  if (t.finished) {
    t.finished = false;
    t.paused = false;
    t.awaiting = null;
    t.idx = t.spec.phases.length - 1;
    stopAlarm(t);
    setSegment(t, 30);
  } else if (t.awaiting) {
    // re-cook the CURRENT step for 30s; it'll re-alert when those 30s are up
    t.awaiting = null;
    t.paused = false;
    stopAlarm(t);
    setSegment(t, 30);
  } else {
    t.remaining += 30;
    t.segmentEndsAt += 30000;
  }
  renderTimer(t);
  armServerAlert(t);
  persistCook(t);
});

$("#timer-stop").addEventListener("click", async () => {
  const t = timer;
  if (!t) return;
  if (!t.finished) {
    const ok = await confirmDialog("Stop this timer? This resets its steps and timers.", {
      okLabel: "Stop timer",
      danger: true,
    });
    if (!ok) return;
  }
  stopCook(t);
});

async function stopCook(t) {
  stopAlarm(t);
  disarmServerAlert(t);
  deleteCookState(t.id);
  try { await t.wakeLock?.release(); } catch {}
  timers = timers.filter((x) => x !== t);
  if (t === timer) {
    timer = null;
    $("#timer").classList.add("hidden");
    $("#timer").classList.remove("alerting");
  }
  if (t.spec.id) api("/api/entries/" + t.spec.id + "/cooked", { method: "POST" }).then(loadEntries).catch(() => {});
  renderPills();
  stopTickLoopIfIdle();
}

// Returning to a backgrounded app: recompute every running cook immediately.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  timers.slice().forEach((t) => { if (!t.paused && !t.finished) tickOne(t); });
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
  const wantKey = urlBase64ToUint8Array(publicKey);
  let sub = await swReg.pushManager.getSubscription();
  // If an existing subscription was created with a DIFFERENT VAPID key (server
  // keys were rotated), the push service rejects sends with VapidPkHashMismatch.
  // Drop the stale one — locally and on the server — then subscribe with the
  // current key. Without this, re-enabling just returns the broken subscription.
  if (sub && !appServerKeyMatches(sub, wantKey)) {
    const stale = sub.endpoint;
    try { await sub.unsubscribe(); } catch {}
    await api("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: stale }),
    }).catch(() => {});
    sub = null;
  }
  if (!sub) {
    sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wantKey,
    });
  }
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  pushEndpoint = sub.endpoint; // enables server-armed timer alerts for this device
  return sub;
}

// True if the subscription was created with the same VAPID key the server uses now.
function appServerKeyMatches(sub, wantKey) {
  const cur = sub.options?.applicationServerKey;
  if (!cur) return false;
  const a = new Uint8Array(cur);
  if (a.length !== wantKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== wantKey[i]) return false;
  return true;
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
  btn.textContent = granted ? "Test Alerts" : "Enable Alerts";
  btn.dataset.state = granted ? "ready" : "enable";
}

async function onAlertsClick() {
  const btn = $("#alerts-btn");
  try {
    const wasReady = btn.dataset.state === "ready";
    // Always (re)validate the subscription before testing — this refreshes a
    // subscription left stale by a VAPID key rotation, even in the "ready" state.
    await subscribePush();
    updateAlertsUI();
    if (!wasReady) toast("Alerts enabled. Sending a test…");
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
