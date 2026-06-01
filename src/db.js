import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// All persistent state lives under DATA_DIR so a single Docker volume covers
// both the SQLite file and uploaded photos.
const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "airfry.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS appliances (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    wattage   INTEGER
  );

  CREATE TABLE IF NOT EXISTS entries (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    brand                TEXT,
    category             TEXT,
    temp                 INTEGER,
    temp_unit            TEXT DEFAULT 'F',
    preheat              INTEGER DEFAULT 0,
    preheat_time_seconds INTEGER,
    servings_note        TEXT,
    notes                TEXT,
    appliance_id         INTEGER REFERENCES appliances(id),
    photo_filename       TEXT,
    rating               INTEGER DEFAULT 0,
    last_cooked_at       TEXT,
    created_at           TEXT DEFAULT (datetime('now')),
    updated_at           TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS steps (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    temp_override    INTEGER,
    end_action       TEXT DEFAULT 'none',   -- none | flip | shake | toss | custom | done
    action_note      TEXT
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
  );

  -- Web Push subscriptions (one row per browser/device that opted in).
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ---- Migrations -----------------------------------------------------------
// Photo focal point (0–100%) for non-destructive repositioning of the card crop.
const entryCols = db.prepare("PRAGMA table_info(entries)").all().map((c) => c.name);
if (!entryCols.includes("focus_x"))
  db.exec("ALTER TABLE entries ADD COLUMN focus_x REAL DEFAULT 50");
if (!entryCols.includes("focus_y"))
  db.exec("ALTER TABLE entries ADD COLUMN focus_y REAL DEFAULT 50");

// ---- Seed (only on a fresh database) -------------------------------------
const entryCount = db.prepare("SELECT COUNT(*) AS n FROM entries").get().n;
if (entryCount === 0) {
  const seed = db.transaction(() => {
    const applianceId = db
      .prepare("INSERT INTO appliances (name, wattage) VALUES (?, ?)")
      .run("Bella Pro", 1700).lastInsertRowid;

    const entryId = db
      .prepare(
        `INSERT INTO entries
          (name, brand, category, temp, temp_unit, preheat, preheat_time_seconds,
           servings_note, notes, appliance_id, rating, last_cooked_at)
         VALUES (@name, @brand, @category, @temp, @temp_unit, @preheat, @preheat_time_seconds,
                 @servings_note, @notes, @appliance_id, @rating, @last_cooked_at)`
      )
      .run({
        name: "Frozen French Fries",
        brand: "Ore-Ida Golden Crinkles",
        category: "Frozen",
        temp: 400,
        temp_unit: "F",
        preheat: 1,
        preheat_time_seconds: 180,
        servings_note: "Single layer, ~1/2 bag",
        notes: "Shake at the first beep, then finish until golden and crisp.",
        appliance_id: applianceId,
        rating: 4,
        last_cooked_at: "2026-05-28",
      }).lastInsertRowid;

    // Two steps: shake at 8:00, then finish for 7:00 more (total 15:00).
    const insStep = db.prepare(
      `INSERT INTO steps (entry_id, position, duration_seconds, temp_override, end_action, action_note)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insStep.run(entryId, 0, 8 * 60, null, "shake", null);
    insStep.run(entryId, 1, 7 * 60, null, "done", null);

    const insTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
    const getTag = db.prepare("SELECT id FROM tags WHERE name = ?");
    const linkTag = db.prepare(
      "INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)"
    );
    for (const t of ["fries", "frozen", "sides"]) {
      insTag.run(t);
      linkTag.run(entryId, getTag.get(t).id);
    }
  });
  seed();
  console.log("Seeded database with one example entry.");
}

export { db, DATA_DIR, UPLOADS_DIR };
