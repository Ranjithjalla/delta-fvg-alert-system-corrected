/*
 * backtestEngine.js
 *
 * Historical backtester for the FVG/IFVG alert system.
 *
 * DESIGN PRINCIPLE (non-negotiable):
 * This module imports detectZones() directly from fvgEngine.js — the
 * exact same function the live server uses in processClosedCandle() /
 * initializeZoneState(). There is no second copy of the FVG rules here.
 * If fvgEngine.js changes (e.g. MIN_GAP_POINTS), the backtester picks
 * it up automatically and can never silently drift from the live engine.
 *
 * WHAT THIS MEASURES
 * This is an alert system, not an execution system, so "win/loss" is
 * defined explicitly rather than assumed:
 *
 *   ENTRY  = the price of the first candle that touches the zone
 *            (first intrusion) after the zone forms.
 *   RISK   = distance from entry to the far side of the zone
 *            (the opposite boundary from the touch), i.e. the
 *            zone acting as an invalidation level. This is the
 *            "1R" unit.
 *   OUTCOME = walking forward candle-by-candle from the touch,
 *            for at most `lookaheadCandles` candles (default 20),
 *            using ONLY candles that occur after the touch candle:
 *              WIN  if price reaches +1R in the zone's implied
 *                   direction before it reaches -1R.
 *              LOSS if price reaches -1R first.
 *              OPEN if neither is reached within the lookahead
 *                   window (excluded from win rate, reported
 *                   separately).
 *
 * This mirrors standard price-action backtesting methodology
 * (fixed R-multiple, no look-ahead, no re-labeling after the fact)
 * and deliberately avoids inventing a "profitable" claim — it only
 * reports what an idealized 1R:1R bracket would have done, which is
 * a measuring stick, not a trading recommendation.
 *
 * NO LOOK-AHEAD
 * - Zone formation only ever looks at candles up to and including C3
 *   (enforced by fvgEngine.detectZones itself).
 * - Entry/outcome evaluation only ever looks at candles strictly
 *   after the touch candle.
 * - Nothing here re-computes or relabels a signal using information
 *   that would not have existed at the time.
 */

'use strict';

const { detectZones } = require('./fvgEngine');

/**
 * @param {Array} candles      Full closed-candle history, oldest -> newest.
 * @param {string} symbol
 * @param {string} tf
 * @param {object} opts
 * @param {string} opts.invRule       'close' | 'wick'   (default 'close')
 * @param {string} opts.fillRule      'touch' | '50' | 'full' (default 'full')
 * @param {number} opts.lookaheadCandles  max candles to walk forward looking
 *                                        for +1R/-1R after touch (default 20)
 * @returns {object} results
 */
function runBacktest(candles, symbol, tf, opts = {}) {
  const invRule = opts.invRule || 'close';
  const fillRule = opts.fillRule || 'full';
  const lookaheadCandles = opts.lookaheadCandles || 20;
  const minGapPoints = opts.minGapPoints; // undefined -> fvgEngine's own default (200)

  // Same authoritative detection the live engine uses.
  const zones = detectZones(candles, symbol, tf, { invRule, fillRule, minGapPoints });

  const byTime = indexByTime(candles);

  const trades = [];

  for (const zone of zones) {
    const c3Idx = byTime.get(zone.c3Time);
    if (c3Idx === undefined) continue;

    // Only ever look at candles strictly after the zone existed.
    const after = candles.slice(c3Idx + 1);

    const touchIdx = after.findIndex(
      c => c.low <= zone.upperPrice && c.high >= zone.lowerPrice
    );
    if (touchIdx === -1) {
      trades.push(openTrade(zone, 'NO_TOUCH'));
      continue;
    }

    const touchCandle = after[touchIdx];
    const entry =
      zone.direction === 'bullish' ? zone.upperPrice : zone.lowerPrice;
    const risk =
      zone.direction === 'bullish'
        ? entry - zone.lowerPrice
        : zone.upperPrice - entry;

    if (!(risk > 0)) {
      trades.push(openTrade(zone, 'INVALID_RISK'));
      continue;
    }

    const targetPrice =
      zone.direction === 'bullish' ? entry + risk : entry - risk;
    const stopPrice =
      zone.direction === 'bullish' ? entry - risk : entry + risk;

    const forward = after.slice(
      touchIdx + 1,
      touchIdx + 1 + lookaheadCandles
    );

    let outcome = 'OPEN';
    let exitTime = null;
    let mfe = 0; // in R
    let mae = 0; // in R

    for (const c of forward) {
      const favorable =
        zone.direction === 'bullish'
          ? (c.high - entry) / risk
          : (entry - c.low) / risk;
      const adverse =
        zone.direction === 'bullish'
          ? (entry - c.low) / risk
          : (c.high - entry) / risk;

      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);

      const hitTarget =
        zone.direction === 'bullish'
          ? c.high >= targetPrice
          : c.low <= targetPrice;
      const hitStop =
        zone.direction === 'bullish'
          ? c.low <= stopPrice
          : c.high >= stopPrice;

      // If both a stop and target could be hit within the same candle,
      // we can't know which happened first from OHLC alone — resolved
      // conservatively as a loss rather than assumed as a win.
      if (hitStop) {
        outcome = 'LOSS';
        exitTime = c.time;
        break;
      }
      if (hitTarget) {
        outcome = 'WIN';
        exitTime = c.time;
        break;
      }
    }

    trades.push({
      id: zone.id,
      timeframe: tf,
      direction: zone.direction,
      gapSize: zone.gapSize,
      c1Time: zone.c1Time,
      c3Time: zone.c3Time,
      touchTime: touchCandle.time,
      exitTime,
      outcome,
      rMultiple:
        outcome === 'WIN' ? 1 : outcome === 'LOSS' ? -1 : mfe - mae,
      mfe,
      mae
    });
  }

  return summarize(trades, { symbol, tf, invRule, fillRule, lookaheadCandles });
}

function openTrade(zone, reason) {
  return {
    id: zone.id,
    timeframe: zone.timeframe,
    direction: zone.direction,
    gapSize: zone.gapSize,
    c1Time: zone.c1Time,
    c3Time: zone.c3Time,
    touchTime: null,
    exitTime: null,
    outcome: reason, // 'NO_TOUCH' | 'INVALID_RISK'
    rMultiple: 0,
    mfe: 0,
    mae: 0
  };
}

function indexByTime(candles) {
  const m = new Map();
  candles.forEach((c, i) => m.set(c.time, i));
  return m;
}

/**
 * Aggregate trade-level results into the metrics the research spec asks for.
 * Every number here is computed only from `trades` — nothing is asserted
 * beyond what the data shows.
 */
function summarize(trades, meta) {
  const decided = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  const wins = decided.filter(t => t.outcome === 'WIN');
  const losses = decided.filter(t => t.outcome === 'LOSS');
  const open = trades.filter(
    t => t.outcome === 'OPEN' || t.outcome === 'NO_TOUCH' || t.outcome === 'INVALID_RISK'
  );

  const grossWinR = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLossR = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));

  const winRate = decided.length ? wins.length / decided.length : null;
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : null;
  const expectancyR = decided.length
    ? decided.reduce((s, t) => s + t.rMultiple, 0) / decided.length
    : null;

  // Max drawdown in cumulative R, walking trades in touch-time order.
  const ordered = decided
    .slice()
    .sort((a, b) => (a.touchTime || 0) - (b.touchTime || 0));
  let cum = 0,
    peak = 0,
    maxDD = 0;
  for (const t of ordered) {
    cum += t.rMultiple;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }

  // Longest win/loss streaks.
  let curWinStreak = 0,
    maxWinStreak = 0,
    curLossStreak = 0,
    maxLossStreak = 0;
  for (const t of ordered) {
    if (t.outcome === 'WIN') {
      curWinStreak++;
      curLossStreak = 0;
    } else {
      curLossStreak++;
      curWinStreak = 0;
    }
    maxWinStreak = Math.max(maxWinStreak, curWinStreak);
    maxLossStreak = Math.max(maxLossStreak, curLossStreak);
  }

  const byDirection = {};
  for (const dir of ['bullish', 'bearish']) {
    const sub = decided.filter(t => t.direction === dir);
    const w = sub.filter(t => t.outcome === 'WIN').length;
    byDirection[dir] = {
      setups: sub.length,
      winRate: sub.length ? w / sub.length : null
    };
  }

  return {
    meta,
    counts: {
      totalSetups: trades.length,
      decided: decided.length,
      open: open.length,
      wins: wins.length,
      losses: losses.length
    },
    winRate,
    profitFactor,
    expectancyR,
    maxDrawdownR: maxDD,
    maxWinStreak,
    maxLossStreak,
    byDirection,
    avgMFE: avg(decided.map(t => t.mfe)),
    avgMAE: avg(decided.map(t => t.mae)),
    trades
  };
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Convenience: run baseline (no MIN_GAP_POINTS-style filter — pass
 * overrideMinGap:0 style opts through your own fvgEngine fork point if
 * you add one) vs the current fvgEngine as "filtered", side by side.
 * Today both baseline and filtered call the SAME fvgEngine, so this is
 * a placeholder shape for when a second, explicitly-parameterized
 * filter (beyond MIN_GAP_POINTS) is added — see backtestCompare.js.
 */
module.exports = {
  runBacktest,
  summarize
};
