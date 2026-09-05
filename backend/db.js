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

try { db.prepare('ALTER TABLE user_settings ADD COLUMN liquidity_buy INTEGER NOT NULL DEFAULT 1').run(); } catch (_) {}
try { db.prepare('ALTER TABLE user_settings ADD COLUMN liquidity_sell INTEGER NOT NULL DEFAULT 1').run(); } catch (_) {}

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
  liquidity_buy INTEGER NOT NULL DEFAULT 1,
  liquidity_sell INTEGER NOT NULL DEFAULT 1,
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

-- Persisted OHLC history, separate from the in-memory DeltaFeed.buffers
-- used for the live chart. Populated by historyBackfill.js and kept
-- current going forward so the backtester/scoring research has more
-- than the last ~REST_LIMIT candles to work with, and so out-of-sample /
-- walk-forward splits have real history to draw on.
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, timeframe, time)
);
CREATE INDEX IF NOT EXISTS idx_candles_tf_time ON candles(timeframe, time);

CREATE TABLE IF NOT EXISTS liquidity_levels (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  first_time INTEGER NOT NULL,
  last_time INTEGER NOT NULL,
  touches INTEGER NOT NULL DEFAULT 1,
  is_equal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  swept_at INTEGER,
  sweep_price REAL,
  sweep_quality REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liq_tf_time ON liquidity_levels(timeframe, last_time DESC);
CREATE INDEX IF NOT EXISTS idx_liq_status ON liquidity_levels(status);
`);

// Remove legacy sub-200 zones left by older builds. The current production
// rule is authoritative: a zone below 200 points must not be displayed or alerted.
try { db.prepare('DELETE FROM fvg_zones WHERE gap_size < 200').run(); } catch (_) {}


const insertSystemEvent = db.prepare(`INSERT INTO system_events(level,event,details,created_at) VALUES(?,?,?,?)`);
function recordSystemEvent(level, event, details = null) {
  try { insertSystemEvent.run(level, event, details ? JSON.stringify(details) : null, Date.now()); } catch (_) {}
}

// =====================================================
// CANDLE HISTORY — persisted store for backtesting/research.
// Not used by the live server's chart path (that stays on
// DeltaFeed.buffers, unchanged); only historyBackfill.js writes
// here, and only the backtest scripts read from it.
// =====================================================

const upsertCandleStmt = db.prepare(`
  INSERT INTO candles(symbol, timeframe, time, open, high, low, close, volume)
  VALUES(@symbol, @timeframe, @time, @open, @high, @low, @close, @volume)
  ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
    open = excluded.open,
    high = excluded.high,
    low = excluded.low,
    close = excluded.close,
    volume = excluded.volume
`);

function upsertCandles(symbol, timeframe, candles) {
  const tx = db.transaction(rows => {
    for (const c of rows) {
      upsertCandleStmt.run({
        symbol,
        timeframe,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0
      });
    }
  });
  tx(candles);
  return candles.length;
}

function getCandles(symbol, timeframe, startMs, endMs) {
  return db.prepare(`
    SELECT time, open, high, low, close, volume
    FROM candles
    WHERE symbol = ? AND timeframe = ? AND time >= ? AND time <= ?
    ORDER BY time ASC
  `).all(symbol, timeframe, startMs, endMs);
}

function getCandleBounds(symbol, timeframe) {
  return db.prepare(`
    SELECT MIN(time) AS minTime, MAX(time) AS maxTime, COUNT(*) AS count
    FROM candles
    WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe);
}


const upsertLiquidityStmt = db.prepare(`
  INSERT INTO liquidity_levels(
    id,symbol,timeframe,side,price,first_time,last_time,touches,is_equal,status,
    swept_at,sweep_price,sweep_quality,created_at,updated_at
  ) VALUES(
    @id,@symbol,@timeframe,@side,@price,@firstTime,@lastTime,@touches,@isEqual,@status,
    @sweptAt,@sweepPrice,@sweepQuality,@createdAt,@updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    price=excluded.price,
    last_time=excluded.last_time,
    touches=excluded.touches,
    is_equal=excluded.is_equal,
    status=excluded.status,
    swept_at=excluded.swept_at,
    sweep_price=excluded.sweep_price,
    sweep_quality=excluded.sweep_quality,
    updated_at=excluded.updated_at
`);
function upsertLiquidityLevel(level, symbol) {
  const now = Date.now();
  upsertLiquidityStmt.run({
    id: level.id, symbol: symbol || level.symbol || 'BTCUSD', timeframe: level.timeframe,
    side: level.side, price: level.price, firstTime: level.firstTime, lastTime: level.lastTime,
    touches: level.touches || 1, isEqual: level.equal ? 1 : 0, status: level.status || 'ACTIVE',
    sweptAt: level.sweptAt ?? null, sweepPrice: level.sweepPrice ?? null,
    sweepQuality: level.sweepQuality || 0, createdAt: level.createdAt || now, updatedAt: now
  });
}
function dbLiquidityToApi(row) {
  if (!row) return null;
  return {
    id: row.id, symbol: row.symbol, timeframe: row.timeframe, side: row.side,
    price: row.price, firstTime: row.first_time, lastTime: row.last_time,
    touches: row.touches, equal: !!row.is_equal, status: row.status,
    sweptAt: row.swept_at, sweepPrice: row.sweep_price, sweepQuality: row.sweep_quality
  };
}

module.exports = {
  upsertLiquidityLevel,
  dbLiquidityToApi,
  db,
  DB_PATH,
  recordSystemEvent,
  upsertCandles,
  getCandles,
  getCandleBounds
};
