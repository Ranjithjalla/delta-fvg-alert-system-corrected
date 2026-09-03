require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const { db, recordSystemEvent } = require('./db');
const { DeltaFeed, TF_ORDER, TF_CONFIG, SYMBOL, validateCandleSequence } = require('./deltaFeed');
const { detectZones, findNewClosedFvgs, priceTouchesZone } = require('./fvgEngine');
const alertService = require('./alertService');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(cors());
app.use(express.json({ limit:'256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path:'/ws' });

const state = {
  startedAt: Date.now(),
  lastPrice: null,
  lastPriceAt: 0,
  lastError: null,
  lastSignalAt: 0,
  initialized: false,
  liveProcessingEnabled: false,
  zones: Object.fromEntries(TF_ORDER.map(tf => [tf, new Map()])),
  status: Object.fromEntries(TF_ORDER.map(tf => [tf, { gapDetected:false, lastCandle:0, candles:0 }])),
  lastSuccessfulRestSync: 0
};

function log(msg, meta) {
  const line = meta ? msg + ' ' + JSON.stringify(meta) : msg;
  console.log(line);
  recordSystemEvent('INFO', msg, meta || null);
}
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(payload); } catch (_) {} } });
}
function persistZone(z) {
  db.prepare(`INSERT INTO fvg_zones(id,symbol,timeframe,direction,c1_time,c2_time,c3_time,creation_time,upper_price,lower_price,gap_size,status,is_ifvg,ifvg_direction,created_at,updated_at)
    VALUES(@id,@symbol,@timeframe,@direction,@c1Time,@c2Time,@c3Time,@creationTime,@upperPrice,@lowerPrice,@gapSize,@status,@isIFVG,@ifvgDirection,@createdAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,is_ifvg=excluded.is_ifvg,ifvg_direction=excluded.ifvg_direction,updated_at=excluded.updated_at`).run({ ...z, isIFVG:z.isIFVG?1:0, createdAt:z.createdAt||Date.now(), updatedAt:Date.now() });
}
function dbZoneToApi(row) {
  if (!row) return null;
  return { id:row.id,symbol:row.symbol,timeframe:row.timeframe,direction:row.direction,c1Time:row.c1_time,c2Time:row.c2_time,c3Time:row.c3_time,time:row.creation_time,creationTime:row.creation_time,upperPrice:row.upper_price,lowerPrice:row.lower_price,gapSize:row.gap_size,status:row.status,isIFVG:!!row.is_ifvg,ifvgDirection:row.ifvg_direction };
}

async function initializeZoneState(tf, candles) {
  const zones = detectZones(candles, SYMBOL, tf, { invRule:'close', fillRule:'full' });
  state.zones[tf].clear();
  for (const z of zones) {
    const existing = db.prepare('SELECT * FROM fvg_zones WHERE id=?').get(z.id);
    const merged = { ...z, createdAt:existing ? existing.created_at : Date.now() };
    persistZone(merged);
    state.zones[tf].set(z.id, merged);
  }
  broadcast({ type:'zones', tf, zones:[...state.zones[tf].values()] });
}

async function processClosedCandle(tf, candles) {
  const newZones = findNewClosedFvgs(candles, SYMBOL, tf);
  for (const z of newZones) {
    const existing = db.prepare('SELECT * FROM fvg_zones WHERE id=?').get(z.id);
    const full = { ...z, createdAt: existing ? existing.created_at : Date.now() };
    persistZone(full);
    state.zones[tf].set(full.id, full);
    broadcast({ type:'zone', event:'created', zone:full });
    log('[FVG] New ' + z.direction + ' FVG', { tf, id:z.id });
  }

  // Recompute lifecycle from authoritative closed candles, then compare state.
  const all = detectZones(candles, SYMBOL, tf, { invRule:'close', fillRule:'full' });
  const next = new Map(all.map(z => [z.id,z]));
  for (const [id, old] of state.zones[tf]) {
    const z = next.get(id);
    if (!z) continue;
    const wasIfvg = old.isIFVG;
    const full = { ...old, ...z, createdAt:old.createdAt || Date.now() };
    persistZone(full);
    state.zones[tf].set(id, full);
    if (state.liveProcessingEnabled && !wasIfvg && full.isIFVG) {
      state.lastSignalAt = Date.now();
      broadcast({ type:'alert', event:'IFVG_FLIP', zone:full });
      await alertService.sendAlert(full, 'IFVG_FLIP', log);
      log('[IFVG] ' + full.direction + ' FVG converted to ' + full.ifvgDirection + ' IFVG');
    }
  }
  broadcast({ type:'zones', tf, zones:[...state.zones[tf].values()] });
}

async function processPrice(price) {
  if (!Number.isFinite(price)) return;
  state.lastPrice = price; state.lastPriceAt = Date.now();
  broadcast({ type:'price', symbol:SYMBOL, price, time:Date.now() });
  if (!state.liveProcessingEnabled) return;
  for (const tf of TF_ORDER) {
    for (const [id, zone] of state.zones[tf]) {
      if (zone.isIFVG || zone.status === 'MITIGATED' || zone.status === 'FILLED') continue;
      if (!priceTouchesZone(price, zone)) continue;
      const persisted = db.prepare('SELECT 1 FROM alert_events WHERE zone_id=? AND event_type=?').get(id,'FVG_RETRACE');
      if (persisted) continue;
      state.lastSignalAt = Date.now();
      const updated = { ...zone, status:'PARTIALLY_FILLED' };
      state.zones[tf].set(id, updated);
      persistZone(updated);
      broadcast({ type:'alert', event:'FVG_RETRACE', zone:updated, price });
      await alertService.sendAlert(updated, 'FVG_RETRACE', log);
      log('[ALERT] FVG retracement touched', { tf, id, price });
    }
  }
}

const feed = new DeltaFeed(SYMBOL, async (tf, candles, info) => {
  const validation = validateCandleSequence(candles, tf);
  state.status[tf] = { candles:candles.length, lastCandle:candles.length?candles[candles.length-1].time:0, gapDetected:!validation.ok };
  if (!validation.ok) { state.lastError = `${tf}: ${validation.errors.join('; ')}`; log('[CANDLE-ERROR] '+state.lastError); return; }
  broadcast({ type:'candles', tf, candles });
  if (info.historical || info.backfill) await initializeZoneState(tf, candles);
  if (info.closed && !info.historical) await processClosedCandle(tf, candles);
  state.lastSuccessfulRestSync = feed.lastRestSyncAt;
}, processPrice, log);

alertService.configure();

feed.start().then(() => {
  state.initialized = true;
  // Historical zones are seeded silently. From this point onward only live retraces/flips alert.
  state.liveProcessingEnabled = true;
  log('[SYSTEM] Delta feed initialized; live alert processing enabled');
}).catch(err => {
  state.lastError = err.message;
  console.error('[FATAL] feed failed to start:', err);
  process.exit(1);
});

app.get('/api/candles', (req,res) => {
  const tf = req.query.tf || '5m';
  if (!TF_ORDER.includes(tf)) return res.status(400).json({ error:'unknown timeframe' });
  res.json(feed.buffers[tf] || []);
});
app.get('/api/zones', (req,res) => {
  const tf = req.query.tf || '5m';
  if (!TF_ORDER.includes(tf)) return res.status(400).json({error:'unknown timeframe'});
  if (req.query.id) return res.json(dbZoneToApi(db.prepare('SELECT * FROM fvg_zones WHERE id=?').get(req.query.id)));
  res.json(db.prepare('SELECT * FROM fvg_zones WHERE timeframe=? ORDER BY creation_time DESC LIMIT 500').all(tf).map(dbZoneToApi));
});
app.get('/api/alerts', (req,res) => res.json(db.prepare('SELECT * FROM alert_events ORDER BY created_at DESC LIMIT 200').all()));
app.get('/api/status', (req,res) => {
  res.json({ status:state.initialized && feed.wsConnected ? 'healthy' : 'degraded', backend:'running', deltaWebSocket:feed.wsConnected?'connected':'disconnected', symbol:SYMBOL, timeframes:state.status, activeFVGs:db.prepare("SELECT COUNT(*) c FROM fvg_zones WHERE status IN ('ACTIVE','PARTIALLY_FILLED') AND is_ifvg=0").get().c, ifvgs:db.prepare("SELECT COUNT(*) c FROM fvg_zones WHERE is_ifvg=1 AND status!='MITIGATED'").get().c, lastPrice:state.lastPrice, lastPriceAt:state.lastPriceAt, lastSuccessfulRestSync:feed.lastRestSyncAt, lastError:state.lastError || feed.lastError || null, uptimeSeconds:Math.floor((Date.now()-state.startedAt)/1000) });
});
app.get('/api/health', (req,res) => {
  const healthy = state.initialized && feed.wsConnected && TF_ORDER.every(tf => feed.buffers[tf].length > 0);
  res.status(healthy?200:503).json({ ok:healthy, websocket:feed.wsConnected, initialized:state.initialized, timeframes:Object.fromEntries(TF_ORDER.map(tf=>[tf,{candles:feed.buffers[tf].length,lastCandle:feed.lastCandleTime[tf]}])) });
});
app.get('/api/vapid-public-key', (req,res) => res.json({ key:process.env.VAPID_PUBLIC_KEY || null }));
app.post('/api/subscribe', (req,res) => {
  const { userId, subscription } = req.body || {};
  if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({error:'invalid subscription'});
  const now=Date.now();
  db.prepare(`INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`).run(subscription.endpoint,userId,subscription.keys.p256dh,subscription.keys.auth,now,now);
  db.prepare('INSERT OR IGNORE INTO user_settings(user_id,updated_at) VALUES(?,?)').run(userId,now);
  res.json({ok:true});
});
app.post('/api/unsubscribe', (req,res) => { if (req.body?.endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(req.body.endpoint); res.json({ok:true}); });
app.get('/api/settings', (req,res) => { if (!req.query.userId) return res.status(400).json({error:'userId required'}); res.json(alertService.getSettings(req.query.userId)); });
app.put('/api/settings', (req,res) => {
  const s=req.body||{}; if(!s.user_id) return res.status(400).json({error:'user_id required'}); const now=Date.now();
  db.prepare(`INSERT INTO user_settings(user_id,push_enabled,tf_5m,tf_15m,tf_1h,tf_4h,bull_fvg,bear_fvg,bull_ifvg,bear_ifvg,updated_at) VALUES(@user_id,@push_enabled,@tf_5m,@tf_15m,@tf_1h,@tf_4h,@bull_fvg,@bear_fvg,@bull_ifvg,@bear_ifvg,@updated_at) ON CONFLICT(user_id) DO UPDATE SET push_enabled=excluded.push_enabled,tf_5m=excluded.tf_5m,tf_15m=excluded.tf_15m,tf_1h=excluded.tf_1h,tf_4h=excluded.tf_4h,bull_fvg=excluded.bull_fvg,bear_fvg=excluded.bear_fvg,bull_ifvg=excluded.bull_ifvg,bear_ifvg=excluded.bear_ifvg,updated_at=excluded.updated_at`).run({ user_id:s.user_id,push_enabled:Number(!!s.push_enabled),tf_5m:Number(!!s.tf_5m),tf_15m:Number(!!s.tf_15m),tf_1h:Number(!!s.tf_1h),tf_4h:Number(!!s.tf_4h),bull_fvg:Number(!!s.bull_fvg),bear_fvg:Number(!!s.bear_fvg),bull_ifvg:Number(!!s.bull_ifvg),bear_ifvg:Number(!!s.bear_ifvg),updated_at:now });
  res.json({ok:true});
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({type:'status', symbol:SYMBOL}));
  for(const tf of TF_ORDER) if(feed.buffers[tf].length) ws.send(JSON.stringify({type:'candles',tf,candles:feed.buffers[tf]}));
  for(const tf of TF_ORDER) ws.send(JSON.stringify({type:'zones',tf,zones:[...state.zones[tf].values()]}));
  if(state.lastPrice!==null) ws.send(JSON.stringify({type:'price',symbol:SYMBOL,price:state.lastPrice,time:state.lastPriceAt}));
});

server.listen(PORT, () => console.log(`[SYSTEM] FVG alert backend listening on :${PORT}`));
process.on('SIGINT',()=>{ feed.stop(); server.close(()=>process.exit(0)); });
process.on('SIGTERM',()=>{ feed.stop(); server.close(()=>process.exit(0)); });
