import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      points     INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS markets (
      id         INTEGER PRIMARY KEY,
      city_id    TEXT NOT NULL,
      date       TEXT NOT NULL,           -- local calendar date in the city
      kind       TEXT NOT NULL,           -- 'temp_over' | 'rain'
      line       REAL NOT NULL,           -- °C for temp_over, mm for rain
      forecast   REAL,                    -- forecast value when the market opened
      status     TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'settled'
      outcome    INTEGER,                 -- 1 = YES won, 0 = NO won
      observed   REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (city_id, date, kind)
    );
    CREATE TABLE IF NOT EXISTS bets (
      id         INTEGER PRIMARY KEY,
      market_id  INTEGER NOT NULL REFERENCES markets(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      side       INTEGER NOT NULL CHECK (side IN (0, 1)),
      amount     INTEGER NOT NULL CHECK (amount > 0),
      payout     INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS bets_market ON bets(market_id);
    CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id);
  `);
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
