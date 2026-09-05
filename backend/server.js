require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');

const { db, recordSystemEvent, upsertLiquidityLevel, dbLiquidityToApi } = require('./db');
const {
  DeltaFeed,
  TF_ORDER,
  TF_CONFIG,
  SYMBOL,
  validateCandleSequence
} = require('./deltaFeed');

const {
  detectZones,
  findNewClosedFvgs,
  priceTouchesZone
} = require('./fvgEngine');

const alertService = require('./alertService');
const {
  DEFAULT_EQUAL_TOLERANCE_POINTS,
  buildLevels,
  findNewConfirmedLevels,
  sweepEventsForLatestCandle,
  reconstructLiquidity,
  qualityScore
} = require('./liquidityEngine');

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Serve frontend from backend/public
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/ws'
});


// =====================================================
// APPLICATION STATE
// =====================================================

const state = {
  startedAt: Date.now(),

  lastPrice: null,
  lastPriceAt: 0,

  lastError: null,
  lastSignalAt: 0,

  initialized: false,
  liveProcessingEnabled: false,

  zones: Object.fromEntries(
    TF_ORDER.map(tf => [tf, new Map()])
  ),

  liquidity: Object.fromEntries(
    TF_ORDER.map(tf => [tf, new Map()])
  ),

  status: Object.fromEntries(
    TF_ORDER.map(tf => [
      tf,
      {
        gapDetected: false,
        lastCandle: 0,
        candles: 0
      }
    ])
  ),

  lastSuccessfulRestSync: 0
};


// =====================================================
// LOGGING
// =====================================================

function log(msg, meta) {
  const line = meta
    ? msg + ' ' + JSON.stringify(meta)
    : msg;

  console.log(line);

  recordSystemEvent(
    'INFO',
    msg,
    meta || null
  );
}


// =====================================================
// WEBSOCKET BROADCAST
// =====================================================

function broadcast(message) {
  const payload = JSON.stringify(message);

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (_) {
        // Ignore broken websocket clients
      }
    }
  });
}


// =====================================================
// DATABASE ZONE PERSISTENCE
// =====================================================

function persistZone(z) {
  db.prepare(`
    INSERT INTO fvg_zones(
      id,
      symbol,
      timeframe,
      direction,
      c1_time,
      c2_time,
      c3_time,
      creation_time,
      upper_price,
      lower_price,
      gap_size,
      status,
      is_ifvg,
      ifvg_direction,
      created_at,
      updated_at
    )
    VALUES(
      @id,
      @symbol,
      @timeframe,
      @direction,
      @c1Time,
      @c2Time,
      @c3Time,
      @creationTime,
      @upperPrice,
      @lowerPrice,
      @gapSize,
      @status,
      @isIFVG,
      @ifvgDirection,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      is_ifvg = excluded.is_ifvg,
      ifvg_direction = excluded.ifvg_direction,
      updated_at = excluded.updated_at
  `).run({
    ...z,

    isIFVG: z.isIFVG ? 1 : 0,

    createdAt:
      z.createdAt || Date.now(),

    updatedAt:
      Date.now()
  });
}


// =====================================================
// DATABASE → API ZONE
// =====================================================

function dbZoneToApi(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,

    c1Time: row.c1_time,
    c2Time: row.c2_time,
    c3Time: row.c3_time,

    time: row.creation_time,
    creationTime: row.creation_time,

    upperPrice: row.upper_price,
    lowerPrice: row.lower_price,

    gapSize: row.gap_size,

    status: row.status,

    isIFVG: !!row.is_ifvg,
    ifvgDirection: row.ifvg_direction
  };
}


// =====================================================
// INITIALIZE HISTORICAL ZONES
// =====================================================

async function initializeZoneState(tf, candles) {
  const zones = detectZones(
    candles,
    SYMBOL,
    tf,
    {
      invRule: 'close',
      fillRule: 'full'
    }
  );

  state.zones[tf].clear();

  for (const z of zones) {
    const existing = db
      .prepare('SELECT * FROM fvg_zones WHERE id=?')
      .get(z.id);

    const merged = {
      ...z,

      createdAt:
        existing
          ? existing.created_at
          : Date.now()
    };

    persistZone(merged);

    state.zones[tf].set(
      z.id,
      merged
    );
  }

  broadcast({
    type: 'zones',
    tf,
    zones: [
      ...state.zones[tf].values()
    ]
  });
}



// =====================================================
// LIQUIDITY STATE / CONFLUENCE
// =====================================================

const LIQ_OPTS = {
  left: Math.max(1, Number(process.env.LIQUIDITY_LEFT || 2)),
  right: Math.max(1, Number(process.env.LIQUIDITY_RIGHT || 2)),
  tolerancePoints: Math.max(0, Number(process.env.LIQUIDITY_EQUAL_TOLERANCE_POINTS || DEFAULT_EQUAL_TOLERANCE_POINTS)),
  minTouches: 1,
  maxLevels: Math.max(20, Number(process.env.LIQUIDITY_MAX_LEVELS || 80))
};
const LIQ_FVG_PROXIMITY = Math.max(0, Number(process.env.LIQUIDITY_FVG_PROXIMITY_POINTS || 500));
const LIQ_SWEEP_MIN_QUALITY = Math.max(0, Number(process.env.LIQUIDITY_SWEEP_MIN_QUALITY || 0));

function liquidityContext(tf, level) {
  const zones = [...state.zones[tf].values()];
  const near = zones.some(z => Math.abs(level.price - z.lowerPrice) <= LIQ_FVG_PROXIMITY || Math.abs(level.price - z.upperPrice) <= LIQ_FVG_PROXIMITY);
  const bullishFvg = zones.some(z => !z.isIFVG && z.direction === 'bullish' && Math.abs(level.price - z.lowerPrice) <= LIQ_FVG_PROXIMITY * 2);
  const bearishFvg = zones.some(z => !z.isIFVG && z.direction === 'bearish' && Math.abs(level.price - z.upperPrice) <= LIQ_FVG_PROXIMITY * 2);
  const htf = TF_ORDER.indexOf(tf) + 1 < TF_ORDER.length ? TF_ORDER[TF_ORDER.indexOf(tf) + 1] : null;
  let htfAligned = false;
  if (htf) {
    const hz = [...state.zones[htf].values()];
    const desired = level.side === 'sell' ? 'bullish' : 'bearish';
    htfAligned = hz.some(z => !z.isIFVG && z.direction === desired && z.status !== 'MITIGATED' && z.status !== 'FILLED');
  }
  return { fvgNear: near, bullishFvg, bearishFvg, htfAligned };
}

function initializeLiquidityState(tf, candles) {
  const reconstructed = reconstructLiquidity(candles, tf, LIQ_OPTS);
  state.liquidity[tf].clear();
  for (const level of reconstructed) {
    const existing = db.prepare('SELECT * FROM liquidity_levels WHERE id=?').get(level.id);
    const merged = {
      ...level,
      symbol: SYMBOL,
      createdAt: existing ? existing.created_at : Date.now(),
      sweptAt: existing?.swept_at ?? level.sweptAt,
      sweepPrice: existing?.sweep_price ?? level.sweepPrice,
      sweepQuality: existing?.sweep_quality ?? level.sweepQuality
    };
    if (existing?.status === 'SWEPT') merged.status = 'SWEPT';
    upsertLiquidityLevel(merged, SYMBOL);
    state.liquidity[tf].set(merged.id, merged);
  }
  broadcast({ type:'liquidity', tf, levels:[...state.liquidity[tf].values()] });
}

function mergeNewLiquidityLevels(tf, candles) {
  const found = findNewConfirmedLevels(candles, tf, LIQ_OPTS);
  for (const raw of found) {
    // Once a pool has been swept it is historical liquidity. A later pivot
    // at the same price can create a fresh active pool, so never merge a new
    // confirmation into an already-swept level.
    let existing = [...state.liquidity[tf].values()].find(x => x.status === 'ACTIVE' && x.side === raw.side && Math.abs(x.price - raw.price) <= LIQ_OPTS.tolerancePoints);
    if (existing) {
      const touches = existing.touches + 1;
      existing = {
        ...existing,
        price: (existing.price * (touches - 1) + raw.price) / touches,
        lastTime: Math.max(existing.lastTime, raw.time),
        touches,
        equal: touches >= 2,
        updatedAt: Date.now()
      };
    } else {
      existing = {
        id: `LIQ_${tf}_${raw.side}_${raw.time}`,
        timeframe: tf, side: raw.side, price: raw.price,
        firstTime: raw.time, lastTime: raw.time, touches: 1, equal: false,
        status:'ACTIVE', sweptAt:null, sweepPrice:null, sweepQuality:0,
        createdAt:Date.now(), updatedAt:Date.now()
      };
    }
    upsertLiquidityLevel(existing, SYMBOL);
    state.liquidity[tf].set(existing.id, existing);
  }
  const sorted = [...state.liquidity[tf].values()].sort((a,b)=>b.lastTime-a.lastTime).slice(0, LIQ_OPTS.maxLevels);
  state.liquidity[tf] = new Map(sorted.map(x=>[x.id,x]));
}

async function processLiquidityClosedCandle(tf, candles) {
  const latest = candles[candles.length - 1];
  if (!latest) return;

  const active = [...state.liquidity[tf].values()];
  const events = sweepEventsForLatestCandle(active, latest, LIQ_OPTS);

  for (const event of events) {
    if (event.level.sweepQuality < LIQ_SWEEP_MIN_QUALITY) continue;
    const ctx = liquidityContext(tf, event.level);
    const score = qualityScore(event.level, ctx);
    const level = {
      ...event.level,
      symbol: SYMBOL,
      context: ctx,
      confluenceScore: score,
      updatedAt: Date.now()
    };
    state.liquidity[tf].set(level.id, level);
    upsertLiquidityLevel(level, SYMBOL);

    broadcast({ type:'liquidity', tf, levels:[...state.liquidity[tf].values()] });
    broadcast({ type:'alert', event:'LIQUIDITY_SWEEP', liquidity:level, tf, price:level.sweepPrice });
    if (state.liveProcessingEnabled) {
      state.lastSignalAt = Date.now();
      await alertService.sendAlert(level, 'LIQUIDITY_SWEEP', log);
    }
    log('[LIQUIDITY] Sweep detected', { tf, side:level.side, id:level.id, price:level.sweepPrice, score });
  }

  // Only after processing sweeps do we add the newest confirmed pivots.
  // This prevents the confirmation candle itself from becoming a retroactive sweep alert.
  mergeNewLiquidityLevels(tf, candles);
  broadcast({ type:'liquidity', tf, levels:[...state.liquidity[tf].values()] });
}

// =====================================================
// PROCESS CLOSED CANDLE
// =====================================================

async function processClosedCandle(tf, candles) {

  // ---------------------------------------------------
  // Find newly created valid FVGs
  // ---------------------------------------------------

  const newZones = findNewClosedFvgs(
    candles,
    SYMBOL,
    tf
  );

  for (const z of newZones) {

    const existing = db
      .prepare('SELECT * FROM fvg_zones WHERE id=?')
      .get(z.id);

    const full = {
      ...z,

      createdAt:
        existing
          ? existing.created_at
          : Date.now()
    };

    persistZone(full);

    state.zones[tf].set(
      full.id,
      full
    );

    broadcast({
      type: 'zone',
      event: 'created',
      zone: full
    });

    log(
      '[FVG] New ' + z.direction + ' FVG',
      {
        tf,
        id: z.id
      }
    );
  }


  // ---------------------------------------------------
  // Recompute lifecycle from authoritative candles
  // ---------------------------------------------------

  const all = detectZones(
    candles,
    SYMBOL,
    tf,
    {
      invRule: 'close',
      fillRule: 'full'
    }
  );

  const next = new Map(
    all.map(z => [z.id, z])
  );


  // ---------------------------------------------------
  // Compare old state with new state
  // ---------------------------------------------------

  for (const [id, old] of state.zones[tf]) {

    const z = next.get(id);

    if (!z) {
      continue;
    }

    const wasIfvg = old.isIFVG;

    const full = {
      ...old,
      ...z,

      createdAt:
        old.createdAt || Date.now()
    };

    persistZone(full);

    state.zones[tf].set(
      id,
      full
    );


    // -------------------------------------------------
    // IFVG flip alert
    // -------------------------------------------------

    if (
      state.liveProcessingEnabled &&
      !wasIfvg &&
      full.isIFVG
    ) {

      state.lastSignalAt =
        Date.now();

      broadcast({
        type: 'alert',
        event: 'IFVG_FLIP',
        zone: full
      });

      await alertService.sendAlert(
        full,
        'IFVG_FLIP',
        log
      );

      log(
        '[IFVG] ' +
        full.direction +
        ' FVG converted to ' +
        full.ifvgDirection +
        ' IFVG'
      );
    }
  }


  broadcast({
    type: 'zones',
    tf,
    zones: [
      ...state.zones[tf].values()
    ]
  });
}


// =====================================================
// PROCESS LIVE PRICE
// =====================================================

async function processPrice(price) {

  if (!Number.isFinite(price)) {
    return;
  }

  state.lastPrice = price;
  state.lastPriceAt = Date.now();


  // Send live price to frontend

  broadcast({
    type: 'price',
    symbol: SYMBOL,
    price,
    time: Date.now()
  });


  // Don't process alerts until initialization
  // has completed.

  if (!state.liveProcessingEnabled) {
    return;
  }


  // ---------------------------------------------------
  // Check every timeframe
  // ---------------------------------------------------

  for (const tf of TF_ORDER) {

    for (const [id, zone] of state.zones[tf]) {

      // IFVGs don't use normal FVG retrace alert
      if (zone.isIFVG) {
        continue;
      }

      // Already mitigated
      if (
        zone.status === 'MITIGATED' ||
        zone.status === 'FILLED'
      ) {
        continue;
      }


      // -------------------------------------------------
      // Check whether live price touches FVG
      // -------------------------------------------------

      if (!priceTouchesZone(price, zone)) {
        continue;
      }


      // -------------------------------------------------
      // Check database deduplication
      // -------------------------------------------------

      const persisted = db
        .prepare(`
          SELECT 1
          FROM alert_events
          WHERE zone_id=?
            AND event_type=?
        `)
        .get(
          id,
          'FVG_RETRACE'
        );

      if (persisted) {
        continue;
      }


      // -------------------------------------------------
      // FVG retracement detected
      // -------------------------------------------------

      state.lastSignalAt =
        Date.now();

      const updated = {
        ...zone,
        status: 'PARTIALLY_FILLED'
      };

      state.zones[tf].set(
        id,
        updated
      );

      persistZone(updated);


      // Send alert to frontend

      broadcast({
        type: 'alert',
        event: 'FVG_RETRACE',
        zone: updated,
        price
      });


      // Send Telegram + Web Push

      await alertService.sendAlert(
        updated,
        'FVG_RETRACE',
        log
      );


      log(
        '[ALERT] FVG retracement touched',
        {
          tf,
          id,
          price
        }
      );
    }
  }
}



// =====================================================
// DELTA FEED
// =====================================================

const feed = new DeltaFeed(
  SYMBOL,

  async (tf, candles, info) => {

    const validation =
      validateCandleSequence(
        candles,
        tf
      );


    state.status[tf] = {
      candles: candles.length,

      lastCandle:
        candles.length
          ? candles[candles.length - 1].time
          : 0,

      gapDetected:
        !validation.ok
    };


    // -------------------------------------------------
    // Candle validation failed
    // -------------------------------------------------

    if (!validation.ok) {

      state.lastError =
        `${tf}: ${validation.errors.join('; ')}`;

      log(
        '[CANDLE-ERROR] ' +
        state.lastError
      );

      return;
    }


    // Send candles to frontend

    broadcast({
      type: 'candles',
      tf,
      candles
    });


    // -------------------------------------------------
    // Historical / backfill initialization
    // -------------------------------------------------

    if (
      info.historical ||
      info.backfill
    ) {

      await initializeZoneState(
        tf,
        candles
      );
      initializeLiquidityState(tf, candles);
    }


    // -------------------------------------------------
    // New closed candle
    // -------------------------------------------------

    if (
      info.closed &&
      !info.historical
    ) {

      await processClosedCandle(
        tf,
        candles
      );
      await processLiquidityClosedCandle(tf, candles);
    }


    state.lastSuccessfulRestSync =
      feed.lastRestSyncAt;
  },

  processPrice,

  log
);


// =====================================================
// CONFIGURE ALERT SERVICE
// =====================================================

alertService.configure();


// =====================================================
// START DELTA FEED
// =====================================================

feed.start()

  .then(() => {

    state.initialized = true;

    // Historical zones are seeded silently.
    // Only live events after initialization
    // are allowed to trigger alerts.

    state.liveProcessingEnabled = true;

    log(
      '[SYSTEM] Delta feed initialized; live alert processing enabled'
    );
  })

  .catch(err => {

    state.lastError =
      err.message;

    console.error(
      '[FATAL] feed failed to start:',
      err
    );

    process.exit(1);
  });


// =====================================================
// API: CANDLES
// =====================================================

app.get(
  '/api/candles',
  (req, res) => {

    const tf =
      req.query.tf || '5m';

    if (!TF_ORDER.includes(tf)) {

      return res
        .status(400)
        .json({
          error: 'unknown timeframe'
        });
    }

    res.json(
      feed.buffers[tf] || []
    );
  }
);


// =====================================================
// API: ZONES
// =====================================================

app.get(
  '/api/zones',
  (req, res) => {

    const tf =
      req.query.tf || '5m';

    if (!TF_ORDER.includes(tf)) {

      return res
        .status(400)
        .json({
          error: 'unknown timeframe'
        });
    }


    if (req.query.id) {

      return res.json(
        dbZoneToApi(
          db
            .prepare(
              'SELECT * FROM fvg_zones WHERE id=?'
            )
            .get(req.query.id)
        )
      );
    }


    res.json(
      db
        .prepare(`
          SELECT *
          FROM fvg_zones
          WHERE timeframe=?
          ORDER BY creation_time DESC
          LIMIT 500
        `)
        .all(tf)
        .map(dbZoneToApi)
    );
  }
);



// =====================================================
// API: LIQUIDITY
// =====================================================

app.get('/api/liquidity', (req, res) => {
  const tf = req.query.tf || '5m';
  if (!TF_ORDER.includes(tf)) return res.status(400).json({ error:'unknown timeframe' });
  const rows = db.prepare(`SELECT * FROM liquidity_levels WHERE timeframe=? ORDER BY last_time DESC LIMIT 200`).all(tf);
  res.json(rows.map(dbLiquidityToApi));
});

// =====================================================
// API: ALERT HISTORY
// =====================================================

app.get(
  '/api/alerts',
  (req, res) => {

    res.json(
      db
        .prepare(`
          SELECT *
          FROM alert_events
          ORDER BY created_at DESC
          LIMIT 200
        `)
        .all()
    );
  }
);


// =====================================================
// API: STATUS
// =====================================================

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      status:
        state.initialized &&
        feed.wsConnected
          ? 'healthy'
          : 'degraded',

      backend: 'running',

      deltaWebSocket:
        feed.wsConnected
          ? 'connected'
          : 'disconnected',

      symbol: SYMBOL,

      timeframes:
        state.status,

      activeFVGs:
        db
          .prepare(`
            SELECT COUNT(*) c
            FROM fvg_zones
            WHERE status IN (
              'ACTIVE',
              'PARTIALLY_FILLED'
            )
            AND is_ifvg=0
          `)
          .get().c,

      liquidityActive:
        db.prepare(`SELECT COUNT(*) c FROM liquidity_levels WHERE status='ACTIVE'`).get().c,

      liquiditySwept:
        db.prepare(`SELECT COUNT(*) c FROM liquidity_levels WHERE status='SWEPT'`).get().c,

      ifvgs:
        db
          .prepare(`
            SELECT COUNT(*) c
            FROM fvg_zones
            WHERE is_ifvg=1
            AND status!='MITIGATED'
          `)
          .get().c,

      lastPrice:
        state.lastPrice,

      lastPriceAt:
        state.lastPriceAt,

      lastSuccessfulRestSync:
        feed.lastRestSyncAt,

      lastError:
        state.lastError ||
        feed.lastError ||
        null,

      uptimeSeconds:
        Math.floor(
          (Date.now() - state.startedAt) / 1000
        )
    });
  }
);


// =====================================================
// API: HEALTH
// =====================================================

app.get(
  '/api/health',
  (req, res) => {

    const healthy =
      state.initialized &&
      feed.wsConnected &&
      TF_ORDER.every(
        tf =>
          feed.buffers[tf].length > 0
      );


    res
      .status(
        healthy
          ? 200
          : 503
      )
      .json({

        ok: healthy,

        websocket:
          feed.wsConnected,

        initialized:
          state.initialized,

        timeframes:
          Object.fromEntries(
            TF_ORDER.map(tf => [
              tf,
              {
                candles:
                  feed.buffers[tf].length,

                lastCandle:
                  feed.lastCandleTime[tf]
              }
            ])
          )
      });
  }
);


// =====================================================
// TEMPORARY ALERT TEST ENDPOINT
// =====================================================
//
// IMPORTANT:
// TEST_ALERT_KEY is the ENVIRONMENT VARIABLE NAME.
// The actual secret value comes from:
// process.env.TEST_ALERT_KEY
//
// =====================================================

// =====================================================
// TEMPORARY ALERT TEST ENDPOINT
// =====================================================


// =====================================================
// API: VAPID PUBLIC KEY
// =====================================================

app.get(
  '/api/vapid-public-key',
  (req, res) => {

    res.json({
      key:
        process.env.VAPID_PUBLIC_KEY ||
        null
    });
  }
);


// =====================================================
// API: SUBSCRIBE TO PUSH
// =====================================================

app.post(
  '/api/subscribe',
  (req, res) => {

    const {
      userId,
      subscription
    } = req.body || {};


    if (
      !userId ||
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {

      return res
        .status(400)
        .json({
          error:
            'invalid subscription'
        });
    }


    const now =
      Date.now();


    db.prepare(`
      INSERT INTO push_subscriptions(
        endpoint,
        user_id,
        p256dh,
        auth,
        created_at,
        updated_at
      )
      VALUES(
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON CONFLICT(endpoint)
      DO UPDATE SET
        user_id=excluded.user_id,
        p256dh=excluded.p256dh,
        auth=excluded.auth,
        updated_at=excluded.updated_at
    `).run(
      subscription.endpoint,
      userId,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now,
      now
    );


    db.prepare(`
      INSERT OR IGNORE INTO user_settings(
        user_id,
        updated_at
      )
      VALUES(
        ?,
        ?
      )
    `).run(
      userId,
      now
    );


    res.json({
      ok: true
    });
  }
);


// =====================================================
// API: UNSUBSCRIBE
// =====================================================

app.post(
  '/api/unsubscribe',
  (req, res) => {

    if (req.body?.endpoint) {

      db.prepare(
        'DELETE FROM push_subscriptions WHERE endpoint=?'
      ).run(
        req.body.endpoint
      );
    }


    res.json({
      ok: true
    });
  }
);


// =====================================================
// API: GET SETTINGS
// =====================================================

app.get(
  '/api/settings',
  (req, res) => {

    if (!req.query.userId) {

      return res
        .status(400)
        .json({
          error:
            'userId required'
        });
    }


    res.json(
      alertService.getSettings(
        req.query.userId
      )
    );
  }
);


// =====================================================
// API: UPDATE SETTINGS
// =====================================================

app.put(
  '/api/settings',
  (req, res) => {

    const s =
      req.body || {};


    if (!s.user_id) {

      return res
        .status(400)
        .json({
          error:
            'user_id required'
        });
    }


    const now =
      Date.now();


    db.prepare(`
      INSERT INTO user_settings(
        user_id,
        push_enabled,
        tf_5m,
        tf_15m,
        tf_1h,
        tf_4h,
        bull_fvg,
        bear_fvg,
        bull_ifvg,
        bear_ifvg,
        liquidity_buy,
        liquidity_sell,
        updated_at
      )
      VALUES(
        @user_id,
        @push_enabled,
        @tf_5m,
        @tf_15m,
        @tf_1h,
        @tf_4h,
        @bull_fvg,
        @bear_fvg,
        @bull_ifvg,
        @bear_ifvg,
        @liquidity_buy,
        @liquidity_sell,
        @updated_at
      )
      ON CONFLICT(user_id)
      DO UPDATE SET
        push_enabled=excluded.push_enabled,
        tf_5m=excluded.tf_5m,
        tf_15m=excluded.tf_15m,
        tf_1h=excluded.tf_1h,
        tf_4h=excluded.tf_4h,
        bull_fvg=excluded.bull_fvg,
        bear_fvg=excluded.bear_fvg,
        bull_ifvg=excluded.bull_ifvg,
        bear_ifvg=excluded.bear_ifvg,
        liquidity_buy=excluded.liquidity_buy,
        liquidity_sell=excluded.liquidity_sell,
        updated_at=excluded.updated_at
    `).run({

      user_id:
        s.user_id,

      push_enabled:
        Number(!!s.push_enabled),

      tf_5m:
        Number(!!s.tf_5m),

      tf_15m:
        Number(!!s.tf_15m),

      tf_1h:
        Number(!!s.tf_1h),

      tf_4h:
        Number(!!s.tf_4h),

      bull_fvg:
        Number(!!s.bull_fvg),

      bear_fvg:
        Number(!!s.bear_fvg),

      bull_ifvg:
        Number(!!s.bull_ifvg),

      bear_ifvg:
        Number(!!s.bear_ifvg),

      liquidity_buy:
        Number(!!s.liquidity_buy),

      liquidity_sell:
        Number(!!s.liquidity_sell),

      updated_at:
        now
    });


    res.json({
      ok: true
    });
  }
);


// =====================================================
// WEBSOCKET CONNECTION
// =====================================================

wss.on(
  'connection',
  ws => {

    // Initial status

    ws.send(
      JSON.stringify({
        type: 'status',
        symbol: SYMBOL
      })
    );


    // Send candles

    for (const tf of TF_ORDER) {

      if (
        feed.buffers[tf].length
      ) {

        ws.send(
          JSON.stringify({
            type: 'candles',
            tf,
            candles:
              feed.buffers[tf]
          })
        );
      }
    }


    // Send zones

    for (const tf of TF_ORDER) {

      ws.send(
        JSON.stringify({
          type: 'zones',
          tf,
          zones: [
            ...state.zones[tf].values()
          ]
        })
      );
    }


    // Send liquidity levels
    for (const tf of TF_ORDER) {
      ws.send(JSON.stringify({
        type:'liquidity',
        tf,
        levels:[...state.liquidity[tf].values()]
      }));
    }


    // Send latest price

    if (
      state.lastPrice !== null
    ) {

      ws.send(
        JSON.stringify({
          type: 'price',
          symbol: SYMBOL,
          price: state.lastPrice,
          time: state.lastPriceAt
        })
      );
    }
  }
);


// =====================================================
// START HTTP SERVER
// =====================================================

server.listen(
  PORT,
  () => {

    console.log(
      `[SYSTEM] FVG alert backend listening on :${PORT}`
    );
  }
);


// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

process.on(
  'SIGINT',
  () => {

    feed.stop();

    server.close(
      () => process.exit(0)
    );
  }
);


process.on(
  'SIGTERM',
  () => {

    feed.stop();

    server.close(
      () => process.exit(0)
    );
  }
);