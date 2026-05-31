import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
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
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Air Fry Timing running on http://localhost:${PORT}`);
});
