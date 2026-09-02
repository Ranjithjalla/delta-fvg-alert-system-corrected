require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const configured = process.env.DB_PATH || './data/fvg.db';
const DB_PATH = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS fvg_zones (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  c1_time INTEGER NOT NULL,
  c2_time INTEGER NOT NULL,
  c3_time INTEGER NOT NULL,
  creation_time INTEGER NOT NULL,
  upper_price REAL NOT NULL,
  lower_price REAL NOT NULL,
  gap_size REAL NOT NULL,
  status TEXT NOT NULL,
  is_ifvg INTEGER NOT NULL DEFAULT 0,
  ifvg_direction TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fvg_tf_creation ON fvg_zones(timeframe, creation_time DESC);
CREATE INDEX IF NOT EXISTS idx_fvg_status ON fvg_zones(status);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(zone_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  push_enabled INTEGER NOT NULL DEFAULT 1,
  tf_5m INTEGER NOT NULL DEFAULT 1,
  tf_15m INTEGER NOT NULL DEFAULT 1,
  tf_1h INTEGER NOT NULL DEFAULT 1,
  tf_4h INTEGER NOT NULL DEFAULT 1,
  bull_fvg INTEGER NOT NULL DEFAULT 1,
  bear_fvg INTEGER NOT NULL DEFAULT 1,
  bull_ifvg INTEGER NOT NULL DEFAULT 1,
  bear_ifvg INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);
`);

const insertSystemEvent = db.prepare(`INSERT INTO system_events(level,event,details,created_at) VALUES(?,?,?,?)`);
function recordSystemEvent(level, event, details = null) {
  try { insertSystemEvent.run(level, event, details ? JSON.stringify(details) : null, Date.now()); } catch (_) {}
}

module.exports = { db, DB_PATH, recordSystemEvent };
