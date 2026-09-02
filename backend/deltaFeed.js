const WebSocket = require('ws');
const fetch = require('node-fetch');

const TF_CONFIG = {
  '5m': { minutes: 5, ms: 300000, channel: 'candlestick_5m' },
  '15m': { minutes: 15, ms: 900000, channel: 'candlestick_15m' },
  '1h': { minutes: 60, ms: 3600000, channel: 'candlestick_1h' },
  '4h': { minutes: 240, ms: 14400000, channel: 'candlestick_4h' }
};
const TF_ORDER = Object.keys(TF_CONFIG);
const REST_LIMIT = Math.min(2000, Number(process.env.HISTORY_CANDLES || 720));
const REST_BASE = process.env.DELTA_REST_BASE || 'https://api.india.delta.exchange';
const WS_BASE = process.env.DELTA_WS_BASE || 'wss://public-socket.india.delta.exchange';
const SYMBOL = process.env.DELTA_SYMBOL || 'BTCUSD';
const { validateCandleSequence } = require('./candleUtils');

function log(onLog, message, meta) {
  onLog(meta ? message + ' ' + JSON.stringify(meta) : message);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(raw, tf) {
  if (!raw) return null;
  const cfg = TF_CONFIG[tf];
  const open = num(raw.open ?? raw.o);
  const high = num(raw.high ?? raw.h);
  const low = num(raw.low ?? raw.l);
  const close = num(raw.close ?? raw.c);
  const volume = num(raw.volume ?? raw.v) ?? 0;

  let timeRaw = raw.time ?? raw.t ?? raw.timestamp ?? raw.start_time ?? raw.start ?? raw.candle_start_time;
  let time = num(timeRaw);
  if (time !== null) {
    if (time < 1e12) time *= 1000;
    if (time > 1e15) time = Math.floor(time / 1000);
  }

  // Delta's compact candlestick feed exposes ts as the server publish time in
  // microseconds. If the candle-open field is absent, derive the open boundary
  // from that publish timestamp using the subscribed resolution.
  if (time === null) {
    const ts = num(raw.ts ?? raw.TS);
    if (ts !== null) {
      let ms = ts;
      if (ms > 1e15) ms = Math.floor(ms / 1000);
      else if (ms < 1e12) ms *= 1000;
      time = Math.floor(ms / cfg.ms) * cfg.ms;
    }
  }

  if (![open, high, low, close].every(Number.isFinite) || !Number.isFinite(time)) return null;
  return { time, open, high, low, close, volume };
}


async function fetchLatestTrade(symbol) {
  const url = `${REST_BASE}/v2/trades/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Delta trades REST ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`Delta trades REST returned success=false: ${JSON.stringify(json.error || {})}`);
  const rows = Array.isArray(json.result?.trades) ? json.result.trades : [];
  const valid = rows.map(r => ({
    price: num(r.price ?? r.p),
    time: num(r.timestamp ?? r.t ?? r.ts)
  })).filter(x => x.price !== null);
  if (!valid.length) return null;
  const last = valid[valid.length - 1];
  let time = last.time ?? Date.now();
  if (time < 1e12) time *= 1000;
  if (time > 1e15) time = Math.floor(time / 1000);
  return { price: last.price, time };
}

async function fetchCandles(symbol, tf, startMs, endMs) {
  const cfg = TF_CONFIG[tf];
  const params = new URLSearchParams({
    resolution: `${cfg.minutes}m`.replace('60m', '1h').replace('240m', '4h'),
    symbol,
    start: String(Math.floor(startMs / 1000)),
    end: String(Math.floor(endMs / 1000))
  });
  const url = `${REST_BASE}/v2/history/candles?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Delta REST ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`Delta REST returned success=false: ${JSON.stringify(json.error || {})}`);
  const rows = Array.isArray(json.result) ? json.result : [];
  const candles = rows.map(r => normalizeCandle(r, tf)).filter(Boolean);
  return dedupeSort(candles);
}

function dedupeSort(candles) {
  const map = new Map();
  for (const c of candles) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function intervalResolution(tf) {
  const m = TF_CONFIG[tf].minutes;
  return m === 60 ? '1h' : m === 240 ? '4h' : `${m}m`;
}

class DeltaFeed {
  constructor(symbol, onUpdate, onPrice, onLog = () => {}) {
    this.symbol = symbol;
    this.onUpdate = onUpdate;
    this.onPrice = onPrice;
    this.onLog = onLog;
    this.buffers = Object.fromEntries(TF_ORDER.map(tf => [tf, []]));
    this.ws = null;
    this.wsConnected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
    this.stopped = false;
    this.initialized = false;
    this.resyncInProgress = false;
    this.resyncPromise = null;
    this.pendingBackfills = new Map();
    this.lastWsMessageAt = 0;
    this.lastCandleUpdateAt = Object.fromEntries(TF_ORDER.map(tf => [tf, 0]));
    this.lastCandleTime = Object.fromEntries(TF_ORDER.map(tf => [tf, 0]));
    this.lastRestSyncAt = 0;
    this.lastError = null;
    this.watchdogTimer = null;
    this.pingTimer = null;
    this.pongDeadlineTimer = null;
    this.lastPongAt = 0;
    this.lastTradeAt = 0;
  }

  async start() {
    await this.fullInitialize();
    try {
      const latest = await fetchLatestTrade(this.symbol);
      if (latest && this.onPrice) this.onPrice(latest.price, { type: 'trades_rest', t: latest.time });
    } catch (err) {
      this.lastError = err.message;
      log(this.onLog, '[DELTA] latest trade REST seed failed: ' + err.message);
    }
    this.connect();
    this.startWatchdog();
  }

  async fullInitialize() {
    if (this.resyncPromise) return this.resyncPromise;
    this.resyncPromise = (async () => {
      this.resyncInProgress = true;
      try {
        log(this.onLog, '[DELTA] loading historical candles');
        for (const tf of TF_ORDER) {
          const cfg = TF_CONFIG[tf];
          const now = Date.now();
          const start = now - cfg.ms * REST_LIMIT;
          const candles = await fetchCandles(this.symbol, tf, start, now + cfg.ms);
          if (!candles.length) throw new Error(`no candles returned for ${tf}`);
          const repaired = await this.repairSequence(tf, candles);
          const validation = validateCandleSequence(repaired, tf);
          if (!validation.ok) throw new Error(`${tf} history invalid: ${validation.errors.join('; ')}`);
          this.buffers[tf] = repaired.slice(-REST_LIMIT);
          this.lastCandleTime[tf] = this.buffers[tf][this.buffers[tf].length - 1].time;
          this.lastCandleUpdateAt[tf] = Date.now();
          this.onUpdate(tf, this.buffers[tf], { closed: false, historical: true });
          log(this.onLog, `[DELTA] history loaded ${tf}`, { candles: this.buffers[tf].length });
        }
        this.lastRestSyncAt = Date.now();
        this.initialized = true;
      } catch (err) {
        this.lastError = err.message;
        throw err;
      } finally {
        this.resyncInProgress = false;
        this.resyncPromise = null;
      }
    })();
    return this.resyncPromise;
  }

  async backfillFromLast(tf) {
    const cfg = TF_CONFIG[tf];
    const buf = this.buffers[tf];
    if (!buf.length) return this.fullInitialize();
    const last = buf[buf.length - 1].time;
    const end = Date.now() + cfg.ms;
    return this.queueBackfill(tf, last + cfg.ms, end);
  }

  queueBackfill(tf, startMs, endMs) {
    const current = this.pendingBackfills.get(tf);
    if (current) {
      current.startMs = Math.min(current.startMs, startMs);
      current.endMs = Math.max(current.endMs, endMs);
      return current.promise;
    }
    const job = { startMs, endMs, promise: null };
    job.promise = this.runBackfill(tf, job);
    this.pendingBackfills.set(tf, job);
    job.promise.finally(() => this.pendingBackfills.delete(tf));
    return job.promise;
  }

  async runBackfill(tf, job) {
    const cfg = TF_CONFIG[tf];
    log(this.onLog, `[BACKFILL] ${tf} fetching missing candles`, { start: new Date(job.startMs).toISOString(), end: new Date(job.endMs).toISOString() });
    const rows = await fetchCandles(this.symbol, tf, job.startMs, job.endMs);
    const merged = dedupeSort([...this.buffers[tf], ...rows]);
    const repaired = await this.repairSequence(tf, merged);
    const validation = validateCandleSequence(repaired, tf);
    if (!validation.ok) throw new Error(`${tf} backfill still invalid: ${validation.errors.join('; ')}`);
    this.buffers[tf] = repaired.slice(-REST_LIMIT);
    this.lastRestSyncAt = Date.now();
    const last = this.buffers[tf][this.buffers[tf].length - 1];
    this.lastCandleTime[tf] = last.time;
    this.lastCandleUpdateAt[tf] = Date.now();
    this.onUpdate(tf, this.buffers[tf], { closed: false, historical: false, backfill: true });
  }

  async repairSequence(tf, candles) {
    const cfg = TF_CONFIG[tf];
    const sorted = dedupeSort(candles);
    if (sorted.length < 2) return sorted;
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = out[out.length - 1];
      const cur = sorted[i];
      const delta = cur.time - prev.time;
      if (delta === cfg.ms) {
        out.push(cur);
      } else if (delta > cfg.ms) {
        const missing = Math.floor(delta / cfg.ms) - 1;
        log(this.onLog, `[CANDLE-GAP] ${tf} missing ${missing} candle(s)`, { previous: new Date(prev.time).toISOString(), current: new Date(cur.time).toISOString(), missing });
        const rows = await fetchCandles(this.symbol, tf, prev.time + cfg.ms, cur.time - cfg.ms);
        for (const r of rows) {
          if (r.time > prev.time && r.time < cur.time) out.push(r);
        }
        out.push(cur);
      } else if (delta < 0) {
        // sorted data should prevent this; if it appears, keep the newer copy.
        const idx = out.findIndex(x => x.time === cur.time);
        if (idx >= 0) out[idx] = cur;
      }
    }
    return dedupeSort(out);
  }

  connect() {
    if (this.stopped) return;
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {} }
    log(this.onLog, `[DELTA] connecting WebSocket ${WS_BASE}`);
    const ws = new WebSocket(WS_BASE);
    this.ws = ws;

    ws.on('open', () => {
      this.wsConnected = true;
      this.lastWsMessageAt = Date.now();
      this.lastPongAt = Date.now();
      this.reconnectDelay = 2000;
      this.startPingLoop(ws);
      for (const tf of TF_ORDER) {
        this.subscribe(ws, TF_CONFIG[tf].channel, [this.symbol]);
        log(this.onLog, `[DELTA] subscribed ${tf}`);
      }
      this.subscribe(ws, 'trades', [this.symbol]);
      log(this.onLog, '[DELTA] subscribed trades');
      this.subscribe(ws, 'ticker', [this.symbol]);
      log(this.onLog, '[DELTA] subscribed ticker fallback');
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
      this.lastWsMessageAt = Date.now();
    });

    ws.on('message', raw => {
      this.lastWsMessageAt = Date.now();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      this.handleMessage(msg).catch(err => {
        this.lastError = err.message;
        log(this.onLog, '[DELTA] message processing error: ' + err.message);
      });
    });

    ws.on('close', () => {
      this.wsConnected = false;
      log(this.onLog, `[DELTA] WebSocket closed; reconnect in ${this.reconnectDelay}ms`);
      this.scheduleReconnect();
    });

    ws.on('error', err => {
      this.lastError = err.message;
      log(this.onLog, '[DELTA] WebSocket error: ' + err.message);
      try { ws.close(); } catch (_) {}
    });
  }


  startPingLoop(ws) {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongDeadlineTimer);
    this.pingTimer = setInterval(() => {
      if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
        clearTimeout(this.pongDeadlineTimer);
        this.pongDeadlineTimer = setTimeout(() => {
          if (this.ws === ws && this.wsConnected && Date.now() - this.lastPongAt > 5000) {
            log(this.onLog, '[DELTA] pong timeout; terminating stale WebSocket');
            try { ws.terminate(); } catch (_) {}
          }
        }, 5500);
      } catch (_) {}
    }, 25000);
  }

  subscribe(ws, name, symbols) {
    ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name, symbols }] } }));
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat' || msg.type === 'pong' || msg.type === 'subscriptions') return;

    const type = String(msg.type || '');
    if (type === 'trades') {
      const p = num(msg.p ?? msg.price ?? msg.last_price);
      if (p !== null && this.onPrice) {
        this.lastTradeAt = Date.now();
        this.onPrice(p, msg);
      }
      return;
    }
    if (type === 'ticker' || type === 'ob_l1') {
      // New Delta ticker payloads can be compact/nested. Use this only as a
      // fallback; trades is the authoritative live traded price.
      const candidates = [
        msg.p, msg.last_price, msg.close, msg.c, msg.lp, msg.mark_price,
        ...(Array.isArray(msg.d) ? msg.d.flatMap(x => [x?.p, x?.last_price, x?.close, x?.c, x?.lp, x?.mark_price]) : [])
      ];
      const p = candidates.map(num).find(Number.isFinite);
      if (p !== undefined && this.onPrice && Date.now() - this.lastTradeAt > 10000) this.onPrice(p, msg);
      return;
    }

    let tf = null;
    for (const key of TF_ORDER) if (type === TF_CONFIG[key].channel) { tf = key; break; }
    if (!tf && msg.res) {
      const res = String(msg.res);
      tf = TF_ORDER.find(x => intervalResolution(x) === res) || null;
    }
    if (!tf) return;

    const candle = normalizeCandle(msg, tf);
    if (!candle) return;
    await this.handleCandle(tf, candle);
  }

  async handleCandle(tf, candle) {
    const cfg = TF_CONFIG[tf];
    const buf = this.buffers[tf];
    if (!buf.length) { buf.push(candle); return this.emit(tf, false); }

    const last = buf[buf.length - 1];
    const delta = candle.time - last.time;
    let closed = false;

    if (delta === 0) {
      Object.assign(last, candle);
      closed = Date.now() >= last.time + cfg.ms;
    } else if (delta === cfg.ms) {
      // Before appending, make sure the previous candle is actually complete.
      closed = Date.now() >= last.time + cfg.ms;
      buf.push(candle);
    } else if (delta < 0) {
      const idx = buf.findIndex(x => x.time === candle.time);
      if (idx >= 0) Object.assign(buf[idx], candle);
      return this.emit(tf, false);
    } else if (delta > cfg.ms) {
      const missing = Math.floor(delta / cfg.ms) - 1;
      log(this.onLog, `[CANDLE-GAP] ${tf} missing ${missing} candle(s)`, { previous: new Date(last.time).toISOString(), current: new Date(candle.time).toISOString(), missing });
      await this.queueBackfill(tf, last.time + cfg.ms, candle.time - cfg.ms);
      const repairedLast = this.buffers[tf][this.buffers[tf].length - 1];
      if (!repairedLast || candle.time - repairedLast.time !== cfg.ms) {
        throw new Error(`${tf} could not repair gap before live candle`);
      }
      closed = Date.now() >= repairedLast.time + cfg.ms;
      this.buffers[tf].push(candle);
    }

    while (buf.length > REST_LIMIT) buf.shift();
    this.lastCandleTime[tf] = buf[buf.length - 1].time;
    this.lastCandleUpdateAt[tf] = Date.now();
    this.emit(tf, closed);
  }

  emit(tf, closed) {
    this.onUpdate(tf, this.buffers[tf], { closed, historical: false });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        for (const tf of TF_ORDER) await this.backfillFromLast(tf);
      } catch (err) {
        this.lastError = err.message;
        log(this.onLog, '[BACKFILL] reconnect catch-up failed: ' + err.message);
        try { await this.fullInitialize(); } catch (e) { this.lastError = e.message; log(this.onLog, '[DELTA] full resync failed: ' + e.message); }
      }
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }, delay);
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    const interval = Number(process.env.WATCHDOG_INTERVAL_MS || 15000);
    this.watchdogTimer = setInterval(() => {
      if (this.stopped) return;
      const now = Date.now();
      const stale = [];
      for (const tf of TF_ORDER) {
        const cfg = TF_CONFIG[tf];
        const threshold = Math.max(45000, cfg.ms * Number(process.env.FEED_STALE_MULTIPLIER || 3));
        if (now - this.lastCandleUpdateAt[tf] > threshold) stale.push(tf);
      }
      if (!this.wsConnected || stale.length) {
        log(this.onLog, '[WATCHDOG] feed unhealthy', { websocket: this.wsConnected ? 'connected' : 'disconnected', stale });
        if (!this.wsConnected) this.scheduleReconnect();
        else if (stale.length) this.recoverStale(stale).catch(err => { this.lastError = err.message; });
      } else {
        log(this.onLog, '[WATCHDOG] feed healthy');
      }
    }, interval);
  }

  async recoverStale(tfs) {
    for (const tf of tfs) await this.backfillFromLast(tf);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongDeadlineTimer);
    try { this.ws && this.ws.close(); } catch (_) {}
  }
}

module.exports = { DeltaFeed, TF_CONFIG, TF_ORDER, SYMBOL, fetchCandles, fetchLatestTrade, validateCandleSequence };
