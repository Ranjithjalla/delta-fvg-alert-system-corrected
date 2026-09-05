'use strict';

/*
 * Objective liquidity model for BTCUSD.
 *
 * Buy-side liquidity: confirmed swing/equal highs above price.
 * Sell-side liquidity: confirmed swing/equal lows below price.
 *
 * A swing is confirmed only after RIGHT candles have closed, so the detector
 * never uses future information relative to the time the level becomes known.
 * A sweep is confirmed when a later closed candle trades through the level and
 * closes back on the original side.
 */

const DEFAULT_LEFT = 2;
const DEFAULT_RIGHT = 2;
const DEFAULT_EQUAL_TOLERANCE_POINTS = 25;
const DEFAULT_MIN_TOUCHES = 2;
const DEFAULT_MAX_LEVELS = 80;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeOpts(opts = {}) {
  return {
    left: Math.max(1, Number(opts.left ?? DEFAULT_LEFT)),
    right: Math.max(1, Number(opts.right ?? DEFAULT_RIGHT)),
    tolerancePoints: Math.max(0, Number(opts.tolerancePoints ?? process.env.LIQUIDITY_EQUAL_TOLERANCE_POINTS ?? DEFAULT_EQUAL_TOLERANCE_POINTS)),
    minTouches: Math.max(1, Number(opts.minTouches ?? DEFAULT_MIN_TOUCHES)),
    maxLevels: Math.max(10, Number(opts.maxLevels ?? DEFAULT_MAX_LEVELS))
  };
}

function isSwingHigh(candles, i, left, right) {
  if (i - left < 0 || i + right >= candles.length) return false;
  const h = candles[i].high;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (!(h > candles[j].high)) return false;
  }
  return true;
}

function isSwingLow(candles, i, left, right) {
  if (i - left < 0 || i + right >= candles.length) return false;
  const l = candles[i].low;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (!(l < candles[j].low)) return false;
  }
  return true;
}

function clusterLevels(raw, tolerancePoints, minTouches) {
  const clusters = [];
  for (const item of raw) {
    let cluster = clusters.find(x => Math.abs(x.price - item.price) <= tolerancePoints);
    if (!cluster) {
      cluster = {
        side: item.side,
        price: item.price,
        firstTime: item.time,
        lastTime: item.time,
        touches: 0,
        sourceTimes: []
      };
      clusters.push(cluster);
    }
    cluster.touches += 1;
    cluster.firstTime = Math.min(cluster.firstTime, item.time);
    cluster.lastTime = Math.max(cluster.lastTime, item.time);
    cluster.sourceTimes.push(item.time);
    cluster.price = (cluster.price * (cluster.touches - 1) + item.price) / cluster.touches;
  }

  // Single confirmed swing is valid liquidity too; equal-high/low gets a
  // stronger quality score because repeated tests imply a larger pool.
  return clusters.filter(x => x.touches >= minTouches || x.touches === 1);
}

function levelId(tf, side, firstTime, price) {
  return `LIQ_${tf}_${side}_${firstTime}`;
}

function rejectionQuality(candle, level) {
  const range = candle.high - candle.low;
  if (!(range > 0)) return 0;
  const body = Math.abs(candle.close - candle.open);
  const wick = level.side === 'buy'
    ? candle.high - Math.max(candle.open, candle.close)
    : Math.min(candle.open, candle.close) - candle.low;
  return Math.max(0, Math.min(100, Math.round((wick / range) * 70 + (1 - body / range) * 30)));
}

function buildLevels(candles, tf, opts = {}) {
  const o = normalizeOpts(opts);
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    if (isSwingHigh(candles, i, o.left, o.right)) {
      raw.push({ side: 'buy', price: candles[i].high, time: candles[i].time });
    }
    if (isSwingLow(candles, i, o.left, o.right)) {
      raw.push({ side: 'sell', price: candles[i].low, time: candles[i].time });
    }
  }

  const bySide = {
    buy: clusterLevels(raw.filter(x => x.side === 'buy'), o.tolerancePoints, o.minTouches),
    sell: clusterLevels(raw.filter(x => x.side === 'sell'), o.tolerancePoints, o.minTouches)
  };

  const levels = [];
  for (const side of ['buy', 'sell']) {
    for (const x of bySide[side]) {
      levels.push({
        id: levelId(tf, side, x.firstTime, x.price),
        timeframe: tf,
        side,
        price: x.price,
        firstTime: x.firstTime,
        lastTime: x.lastTime,
        touches: x.touches,
        equal: x.touches >= 2,
        status: 'ACTIVE',
        sweptAt: null,
        sweepPrice: null,
        sweepQuality: 0
      });
    }
  }

  levels.sort((a, b) => b.lastTime - a.lastTime);
  return levels.slice(0, o.maxLevels);
}

function findNewConfirmedLevels(candles, tf, opts = {}) {
  const o = normalizeOpts(opts);
  if (candles.length < o.left + o.right + 1) return [];
  const i = candles.length - 1 - o.right;
  const out = [];
  if (isSwingHigh(candles, i, o.left, o.right)) {
    out.push({ side: 'buy', price: candles[i].high, time: candles[i].time });
  }
  if (isSwingLow(candles, i, o.left, o.right)) {
    out.push({ side: 'sell', price: candles[i].low, time: candles[i].time });
  }
  return out;
}

function detectSweeps(levels, candles, opts = {}) {
  const o = normalizeOpts(opts);
  const out = levels.map(x => ({ ...x }));
  for (const level of out) {
    const after = candles.filter(c => c.time > level.lastTime);
    for (const c of after) {
      const swept = level.side === 'buy'
        ? c.high > level.price + o.tolerancePoints && c.close < level.price
        : c.low < level.price - o.tolerancePoints && c.close > level.price;
      if (swept) {
        level.status = 'SWEPT';
        level.sweptAt = c.time;
        level.sweepPrice = level.side === 'buy' ? c.high : c.low;
        level.sweepQuality = rejectionQuality(c, level);
        break;
      }
    }
  }
  return out;
}

function reconstructLiquidity(candles, tf, opts = {}) {
  return detectSweeps(buildLevels(candles, tf, opts), candles, opts);
}

function sweepEventsForLatestCandle(levels, candle, opts = {}) {
  const o = normalizeOpts(opts);
  const events = [];
  for (const level of levels) {
    if (level.status !== 'ACTIVE') continue;
    const swept = level.side === 'buy'
      ? candle.high > level.price + o.tolerancePoints && candle.close < level.price
      : candle.low < level.price - o.tolerancePoints && candle.close > level.price;
    if (swept) {
      events.push({
        level: { ...level, status: 'SWEPT', sweptAt: candle.time, sweepPrice: level.side === 'buy' ? candle.high : candle.low, sweepQuality: rejectionQuality(candle, level) },
        candle
      });
    }
  }
  return events;
}

function qualityScore(level, context = {}) {
  let score = 45;
  score += Math.min(25, Math.max(0, (level.touches - 1) * 10));
  if (level.equal) score += 10;
  if (context.fvgNear) score += 10;
  if (context.htfAligned) score += 10;
  if (level.sweepQuality) score += Math.round(level.sweepQuality * 0.10);
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  DEFAULT_LEFT,
  DEFAULT_RIGHT,
  DEFAULT_EQUAL_TOLERANCE_POINTS,
  isSwingHigh,
  isSwingLow,
  buildLevels,
  findNewConfirmedLevels,
  detectSweeps,
  reconstructLiquidity,
  sweepEventsForLatestCandle,
  qualityScore
};
