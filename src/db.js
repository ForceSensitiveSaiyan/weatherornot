import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 3;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  // Readers don't wait for writers, and a busy moment waits instead of failing.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get();
  if (hasTables && version !== SCHEMA_VERSION) {
    throw new Error(`${path} was made by an older version of WeatherOrNot. ` +
      'Delete it (or set DB_PATH to a new file) to start fresh.');
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = ${SCHEMA_VERSION};
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash  TEXT,                    -- NULL for guests who haven't saved their account
      display    TEXT,                    -- what friends see ("Sam"); NULL until they pick one
      salt       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS places (
      id         TEXT PRIMARY KEY,        -- 'gn:<GeoNames id>'
      name       TEXT NOT NULL,
      country    TEXT NOT NULL,
      lat        REAL NOT NULL,
      lon        REAL NOT NULL,
      tz         TEXT NOT NULL
    );
    -- One daily game per place per local date.
    CREATE TABLE IF NOT EXISTS rounds (
      id         INTEGER PRIMARY KEY,
      place_id   TEXT NOT NULL REFERENCES places(id),
      date       TEXT NOT NULL,
      questions  TEXT NOT NULL,           -- JSON from questionsFor()
      sky        INTEGER,                 -- forecast WMO weather code, for the look of the page
      status     TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'settled'
      results    TEXT,                    -- JSON: key -> { answer, observed, line }
      UNIQUE (place_id, date)
    );
    CREATE TABLE IF NOT EXISTS picks (
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      key        TEXT NOT NULL,
      pick       INTEGER NOT NULL CHECK (pick IN (0, 1)),
      PRIMARY KEY (round_id, user_id, key)
    );
    CREATE INDEX IF NOT EXISTS picks_user ON picks(user_id);
    -- Each player's one double-points call per game.
    CREATE TABLE IF NOT EXISTS bankers (
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      key        TEXT NOT NULL,
      PRIMARY KEY (round_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      correct    INTEGER NOT NULL,
      points     INTEGER NOT NULL,
      detail     TEXT NOT NULL,           -- JSON: key -> { pick, correct, points, bonuses }
      PRIMARY KEY (round_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id);
    -- "Something look wrong?" reports on settled results, reviewed by an admin.
    CREATE TABLE IF NOT EXISTS reports (
      id         INTEGER PRIMARY KEY,
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      key        TEXT,                    -- the question, or NULL for "something else"
      message    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'voided' | 'dismissed'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (round_id, user_id)
    );
    -- Short links for a shared result or challenge: /r/<code>.
    CREATE TABLE IF NOT EXISTS shares (
      code       TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, round_id)
    );
    CREATE TABLE IF NOT EXISTS leagues (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      code       TEXT NOT NULL UNIQUE,
      owner_id   INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS league_members (
      league_id  INTEGER NOT NULL REFERENCES leagues(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, user_id)
    );
    -- One-time links that log you in on another phone (or, made by an admin,
    -- get you back in after forgetting your password).
    CREATE TABLE IF NOT EXISTS login_links (
      code       TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );
    -- Browsers that get morning notifications, and whose they are.
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
    -- Results already sent, so each one goes once.
    CREATE TABLE IF NOT EXISTS push_sent (
      round_id   INTEGER NOT NULL REFERENCES rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (round_id, user_id)
    );
  `);
  // Added after the first databases were made.
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'display')) {
    db.exec('ALTER TABLE users ADD COLUMN display TEXT');
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
