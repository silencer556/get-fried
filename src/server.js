import "./env.js"; // must be first: loads .env before db.js/auth.js read process.env
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import webpush from "web-push";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { db, UPLOADS_DIR } from "./db.js";
import {
  roleForPassword,
  makeCookie,
  attachRole,
  requireEditor,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(attachRole);

// ---- Photo uploads --------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) =>
    cb(null, /^image\//.test(file.mimetype)),
});

app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "7d" }));

// ---- Auth -----------------------------------------------------------------
app.post("/api/login", (req, res) => {
  const role = roleForPassword(req.body?.password);
  if (!role) return res.status(401).json({ error: "Wrong password." });
  res.cookie("afsession", makeCookie(role), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  });
  res.json({ role });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("afsession");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ role: req.role }));

// ---- Web Push -------------------------------------------------------------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@getfried.local";
const pushEnabled = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
else console.warn("Web Push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable.");

const insertSub = db.prepare(
  `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (@endpoint, @p256dh, @auth)
   ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
);
const deleteSub = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
const allSubs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions");
const getSubByEndpoint = db.prepare(
  "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?"
);

// Send to a single subscription by endpoint; prune if the push service dropped it.
async function pushToOne(endpoint, payload) {
  const s = getSubByEndpoint.get(endpoint);
  if (!s) return false;
  try {
    await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      payload
    );
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) deleteSub.run(endpoint);
    return false;
  }
}

// Send a payload to every stored subscription; prune ones the push service has
// dropped (404/410). Returns counts so callers can report status.
async function pushToAll(payload) {
  const subs = allSubs.all();
  let sent = 0,
    pruned = 0;
  const errors = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSub.run(s.endpoint);
          pruned++;
        } else {
          errors.push({
            statusCode: err.statusCode || null,
            body: (err.body || err.message || "").toString().slice(0, 200),
          });
        }
      }
    })
  );
  return { total: subs.length, sent, pruned, errors };
}

// Only logged-in users (editor or viewer) may register/test push.
function requireUser(req, res, next) {
  if (req.role) return next();
  res.status(401).json({ error: "Login required." });
}

app.get("/api/push/key", (req, res) =>
  res.json({ enabled: pushEnabled, publicKey: VAPID_PUBLIC || null })
);

app.post("/api/push/subscribe", requireUser, (req, res) => {
  const s = req.body || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth)
    return res.status(400).json({ error: "Invalid subscription." });
  insertSub.run({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", requireUser, (req, res) => {
  if (req.body?.endpoint) deleteSub.run(req.body.endpoint);
  res.json({ ok: true });
});

app.post("/api/push/test", requireUser, async (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: "Push not configured on the server." });
  const result = await pushToAll(
    JSON.stringify({
      title: "Get Fried",
      body: "Test alert — notifications are working.",
      tag: "getfried-test-" + Date.now(), // unique → always re-alerts (sound/vibrate)
    })
  );
  res.json(result);
});

// ---- Background timer alerts ----------------------------------------------
// The client arms ONE pending push per device when a countdown segment starts,
// and disarms it when the segment ends in the foreground. If the app is
// backgrounded/closed the disarm never comes, so this fires the alert. In-memory
// only: a server restart drops pending alerts (rare; the user can re-run).
const armedAlerts = new Map(); // cookId -> setTimeout handle
const MAX_ARM_SECONDS = 6 * 60 * 60;

function clearArmed(cookId) {
  const h = armedAlerts.get(cookId);
  if (h) {
    clearTimeout(h);
    armedAlerts.delete(cookId);
  }
}

app.post("/api/timer/arm", requireUser, (req, res) => {
  const { cookId, endpoint, fireInSeconds, title, body } = req.body || {};
  if (!pushEnabled) return res.status(503).json({ error: "Push not configured." });
  if (!cookId || !endpoint || !(Number(fireInSeconds) > 0))
    return res.status(400).json({ error: "Bad arm request." });
  const secs = Math.min(Number(fireInSeconds), MAX_ARM_SECONDS);
  clearArmed(cookId);
  const tag = cookId.slice(0, 8);
  console.log(`[timer] armed ${tag} in ${secs}s — "${body}"`);
  const handle = setTimeout(async () => {
    armedAlerts.delete(cookId);
    const ok = await pushToOne(
      endpoint,
      JSON.stringify({
        title: title || "Get Fried",
        body: body || "Timer",
        tag: "getfried-timer-" + cookId,
      })
    );
    console.log(`[timer] fired ${tag} — "${body}" — delivered=${ok}`);
  }, secs * 1000);
  handle.unref?.();
  armedAlerts.set(cookId, handle);
  res.json({ ok: true, fireInSeconds: secs });
});

app.post("/api/timer/disarm", requireUser, (req, res) => {
  if (req.body?.cookId) {
    clearArmed(req.body.cookId);
    console.log(`[timer] disarmed ${req.body.cookId.slice(0, 8)}`);
  }
  res.json({ ok: true });
});

// ---- Active cook persistence (survive app close / phone restart) ----------
// Keyed by cookId so multiple concurrent cooks (e.g. two air fryers) persist.
const upsertCook = db.prepare(
  `INSERT INTO active_cooks (cook_id, device_id, state, updated_at)
   VALUES (@cook_id, @device_id, @state, datetime('now'))
   ON CONFLICT(cook_id) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`
);
const getCookById = db.prepare("SELECT state FROM active_cooks WHERE cook_id = ?");
const getCooksByDevice = db.prepare(
  "SELECT state FROM active_cooks WHERE device_id = ? ORDER BY updated_at"
);
const delCookById = db.prepare("DELETE FROM active_cooks WHERE cook_id = ?");
const delCooksByDevice = db.prepare("DELETE FROM active_cooks WHERE device_id = ?");

app.put("/api/cook/state", requireUser, (req, res) => {
  const s = req.body;
  if (!s?.deviceId || !s?.cookId) return res.status(400).json({ error: "deviceId and cookId required" });
  upsertCook.run({ cook_id: s.cookId, device_id: s.deviceId, state: JSON.stringify(s) });
  res.json({ ok: true });
});

// ?cookId=X → that cook (or null); ?deviceId=X → array of all that device's cooks.
app.get("/api/cook/state", requireUser, (req, res) => {
  if (req.query.cookId) {
    const row = getCookById.get(req.query.cookId);
    return res.json(row ? JSON.parse(row.state) : null);
  }
  const rows = getCooksByDevice.all(req.query.deviceId || "");
  res.json(rows.map((r) => JSON.parse(r.state)));
});

app.delete("/api/cook/state", requireUser, (req, res) => {
  if (req.query.cookId) delCookById.run(req.query.cookId);
  else if (req.query.deviceId) delCooksByDevice.run(req.query.deviceId);
  res.json({ ok: true });
});

// ---- Helpers --------------------------------------------------------------
const getTagsForEntry = db.prepare(
  `SELECT t.name FROM tags t
   JOIN entry_tags et ON et.tag_id = t.id
   WHERE et.entry_id = ? ORDER BY t.name`
);
const getStepsForEntry = db.prepare(
  `SELECT id, position, duration_seconds, temp_override, end_action, action_note
   FROM steps WHERE entry_id = ? ORDER BY position`
);

function hydrate(entry) {
  if (!entry) return entry;
  const steps = getStepsForEntry.all(entry.id);
  return {
    ...entry,
    preheat: !!entry.preheat,
    tags: getTagsForEntry.all(entry.id).map((r) => r.name),
    steps,
    total_time_seconds: steps.reduce((s, x) => s + x.duration_seconds, 0),
  };
}

function setTags(entryId, tags = []) {
  db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(entryId);
  const insTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTag = db.prepare("SELECT id FROM tags WHERE name = ?");
  const link = db.prepare(
    "INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)"
  );
  for (const raw of tags) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    insTag.run(name);
    link.run(entryId, getTag.get(name).id);
  }
}

function setSteps(entryId, steps) {
  db.prepare("DELETE FROM steps WHERE entry_id = ?").run(entryId);
  const ins = db.prepare(
    `INSERT INTO steps (entry_id, position, duration_seconds, temp_override, end_action, action_note)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const list =
    Array.isArray(steps) && steps.length
      ? steps
      : [{ duration_seconds: 0, end_action: "done" }];
  list.forEach((s, i) => {
    ins.run(
      entryId,
      i,
      Math.max(0, Math.round(Number(s.duration_seconds) || 0)),
      s.temp_override != null && s.temp_override !== ""
        ? Math.round(Number(s.temp_override))
        : null,
      s.end_action || (i === list.length - 1 ? "done" : "none"),
      s.action_note || null
    );
  });
}

// ---- Read APIs (any logged-in role) ---------------------------------------
app.get("/api/appliances", (_req, res) => {
  res.json(db.prepare("SELECT * FROM appliances ORDER BY name").all());
});

app.get("/api/tags", (_req, res) => {
  res.json(
    db.prepare("SELECT name FROM tags ORDER BY name").all().map((r) => r.name)
  );
});

app.get("/api/entries", (req, res) => {
  const { q, category, tag, appliance_id } = req.query;
  const where = [];
  const params = {};
  if (q) {
    where.push(
      "(e.name LIKE @q OR e.brand LIKE @q OR e.notes LIKE @q OR EXISTS " +
        "(SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id " +
        "WHERE et.entry_id = e.id AND t.name LIKE @q))"
    );
    params.q = `%${q}%`;
  }
  if (category) {
    where.push("e.category = @category");
    params.category = category;
  }
  if (appliance_id) {
    where.push("e.appliance_id = @appliance_id");
    params.appliance_id = Number(appliance_id);
  }
  if (tag) {
    where.push(
      "EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id " +
        "WHERE et.entry_id = e.id AND t.name = @tag)"
    );
    params.tag = String(tag).toLowerCase();
  }
  const sql =
    `SELECT e.*, a.name AS appliance_name, a.wattage AS appliance_wattage
     FROM entries e LEFT JOIN appliances a ON a.id = e.appliance_id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY e.name COLLATE NOCASE";
  res.json(db.prepare(sql).all(params).map(hydrate));
});

app.get("/api/entries/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT e.*, a.name AS appliance_name, a.wattage AS appliance_wattage
       FROM entries e LEFT JOIN appliances a ON a.id = e.appliance_id
       WHERE e.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found." });
  res.json(hydrate(row));
});

// ---- Write APIs (editor only) ---------------------------------------------
const entryFields = [
  "name", "brand", "category", "temp", "temp_unit", "preheat",
  "preheat_time_seconds", "servings_note", "notes", "appliance_id",
  "rating", "last_cooked_at", "focus_x", "focus_y",
];

const clampPct = (v) =>
  v != null && v !== "" ? Math.max(0, Math.min(100, Number(v))) : 50;

function coerce(body) {
  return {
    name: String(body.name || "").trim(),
    brand: body.brand ?? null,
    category: body.category ?? null,
    temp: body.temp != null && body.temp !== "" ? Math.round(Number(body.temp)) : null,
    temp_unit: body.temp_unit === "C" ? "C" : "F",
    preheat: body.preheat ? 1 : 0,
    preheat_time_seconds:
      body.preheat_time_seconds != null && body.preheat_time_seconds !== ""
        ? Math.round(Number(body.preheat_time_seconds))
        : null,
    servings_note: body.servings_note ?? null,
    notes: body.notes ?? null,
    appliance_id: body.appliance_id ? Number(body.appliance_id) : null,
    rating: body.rating != null ? Math.max(0, Math.min(5, Number(body.rating))) : 0,
    last_cooked_at: body.last_cooked_at || null,
    focus_x: clampPct(body.focus_x),
    focus_y: clampPct(body.focus_y),
  };
}

app.post("/api/entries", requireEditor, (req, res) => {
  const data = coerce(req.body);
  if (!data.name) return res.status(400).json({ error: "Name is required." });
  const result = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO entries (${entryFields.join(", ")})
         VALUES (${entryFields.map((f) => "@" + f).join(", ")})`
      )
      .run(data).lastInsertRowid;
    setSteps(id, req.body.steps);
    setTags(id, req.body.tags);
    return id;
  })();
  res.status(201).json(hydrate(db.prepare("SELECT * FROM entries WHERE id = ?").get(result)));
});

app.put("/api/entries/:id", requireEditor, (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare("SELECT id FROM entries WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Not found." });
  const data = coerce(req.body);
  if (!data.name) return res.status(400).json({ error: "Name is required." });
  db.transaction(() => {
    db.prepare(
      `UPDATE entries SET ${entryFields
        .map((f) => `${f} = @${f}`)
        .join(", ")}, updated_at = datetime('now') WHERE id = @id`
    ).run({ ...data, id });
    if (req.body.steps) setSteps(id, req.body.steps);
    if (req.body.tags) setTags(id, req.body.tags);
  })();
  res.json(hydrate(db.prepare("SELECT * FROM entries WHERE id = ?").get(id)));
});

app.delete("/api/entries/:id", requireEditor, (req, res) => {
  db.prepare("DELETE FROM entries WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Remove the previous photo file from disk so replaced/removed images don't pile up.
function unlinkPhoto(id) {
  const row = db.prepare("SELECT photo_filename FROM entries WHERE id = ?").get(id);
  if (row?.photo_filename) {
    fs.rm(path.join(UPLOADS_DIR, row.photo_filename), { force: true }, () => {});
  }
}

app.post("/api/entries/:id/photo", requireEditor, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded." });
  unlinkPhoto(req.params.id); // drop the old file before pointing at the new one
  db.prepare(
    "UPDATE entries SET photo_filename = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(req.file.filename, req.params.id);
  res.json({ photo_filename: req.file.filename });
});

app.delete("/api/entries/:id/photo", requireEditor, (req, res) => {
  unlinkPhoto(req.params.id);
  db.prepare(
    "UPDATE entries SET photo_filename = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  res.json({ ok: true });
});

// Quick action available to any role: stamp "last cooked" = today.
app.post("/api/entries/:id/cooked", (req, res) => {
  if (!req.role) return res.status(403).json({ error: "Login required." });
  db.prepare(
    "UPDATE entries SET last_cooked_at = date('now') WHERE id = ?"
  ).run(req.params.id);
  res.json({ ok: true });
});

// ---- Static PWA -----------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Per-build token (changes every deploy/restart) injected into index.html so
// Cloudflare/browser caches can't pin a stale app.js or styles.css. index.html
// itself is served no-store, so the fresh token always reaches the client.
const BUILD_ID = Date.now().toString(36);
const INDEX_HTML = fs
  .readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
  .replaceAll("__BUILD__", BUILD_ID);
function serveIndex(_req, res) {
  res.set("Cache-Control", "no-store");
  res.type("html").send(INDEX_HTML);
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// The service worker must always be revalidated so SW updates aren't pinned.
app.get("/sw.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("application/javascript").send(fs.readFileSync(path.join(PUBLIC_DIR, "sw.js")));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Get Fried running on http://localhost:${PORT} (build ${BUILD_ID})`);
});
