/*
 * backtestCompare.js
 *
 * Runs the BASELINE (no minimum-gap filter) vs FILTERED (200-point
 * minimum wick-to-wick gap, i.e. current fvgEngine.MIN_GAP_POINTS)
 * strategy over the same historical candles and prints a side-by-side
 * report, per the "BASELINE VS FILTERED STRATEGY" section of the
 * research spec.
 *
 * USAGE
 *   node backtestCompare.js <candles.json> <tf>
 *
 * <candles.json> must be an array of closed candles, oldest -> newest:
 *   [{ "time": 1690000000000, "open": .., "high": .., "low": .., "close": .. }, ...]
 *
 * WHERE THE CANDLES COME FROM
 * This backend does not currently persist long-run historical candles
 * (the DB schema in server.js only shows fvg_zones / push_subscriptions /
 * user_settings / alert_events — no candles table), so there is no
 * ready-made multi-month history to point this at yet. Options:
 *   1. Export whatever's in feed.buffers[tf] right now (bounded by
 *      REST_LIMIT — currently ~1000 candles per timeframe) via a
 *      temporary debug endpoint, or
 *   2. Add a persisted candle store (recommended for real out-of-sample
 *      / walk-forward testing — see the note at the bottom of this file).
 *
 * This script itself does not fabricate or download data — point it at
 * a real exported candle file.
 */

'use strict';

const fs = require('fs');
const { runBacktest } = require('./backtestEngine');
const { MIN_GAP_POINTS } = require('./fvgEngine');

function main() {
  const [, , candlesPath, tf] = process.argv;

  if (!candlesPath || !tf) {
    console.error('Usage: node backtestCompare.js <candles.json> <tf>');
    process.exit(1);
  }

  const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'));
  const symbol = 'BTCUSD';

  const baseline = runBacktest(candles, symbol, tf, {
    invRule: 'close',
    fillRule: 'full',
    minGapPoints: 0 // no minimum-gap filter
  });

  const filtered = runBacktest(candles, symbol, tf, {
    invRule: 'close',
    fillRule: 'full',
    minGapPoints: MIN_GAP_POINTS // 200, current production value
  });

  printReport(baseline, filtered);
}

function pct(x) {
  return x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%';
}
function num(x, d = 2) {
  return x === null || x === undefined ? 'n/a' : x.toFixed(d);
}

function printReport(baseline, filtered) {
  const rows = [
    ['Total setups', baseline.counts.totalSetups, filtered.counts.totalSetups],
    ['Decided (win or loss)', baseline.counts.decided, filtered.counts.decided],
    ['Still open / no touch', baseline.counts.open, filtered.counts.open],
    ['Win rate', pct(baseline.winRate), pct(filtered.winRate)],
    ['Profit factor', num(baseline.profitFactor), num(filtered.profitFactor)],
    ['Expectancy (R)', num(baseline.expectancyR), num(filtered.expectancyR)],
    ['Max drawdown (R)', num(baseline.maxDrawdownR), num(filtered.maxDrawdownR)],
    ['Max win streak', baseline.maxWinStreak, filtered.maxWinStreak],
    ['Max loss streak', baseline.maxLossStreak, filtered.maxLossStreak],
    ['Avg MFE (R)', num(baseline.avgMFE), num(filtered.avgMFE)],
    ['Avg MAE (R)', num(baseline.avgMAE), num(filtered.avgMAE)]
  ];

  const w1 = Math.max(...rows.map(r => String(r[0]).length), 'METRIC'.length) + 2;
  const w2 = 14;

  console.log(
    'BASELINE vs FILTERED (MIN_GAP_POINTS = ' + MIN_GAP_POINTS + ')\n'
  );
  console.log(
    'METRIC'.padEnd(w1) + 'BASELINE'.padEnd(w2) + 'FILTERED'.padEnd(w2)
  );
  console.log('-'.repeat(w1 + w2 * 2));
  for (const [label, a, b] of rows) {
    console.log(
      String(label).padEnd(w1) + String(a).padEnd(w2) + String(b).padEnd(w2)
    );
  }

  console.log('\nBy direction (filtered):');
  for (const dir of ['bullish', 'bearish']) {
    const d = filtered.byDirection[dir];
    console.log(
      '  ' + dir + ': ' + d.setups + ' setups, win rate ' + pct(d.winRate)
    );
  }

  console.log(
    '\nThese numbers describe an idealized 1R:1R bracket starting at first ' +
    'touch of each zone, evaluated over the next ' +
    filtered.meta.lookaheadCandles +
    ' candles — not a claim about live profitability. See backtestEngine.js ' +
    'header for the exact methodology.'
  );
}

main();

/*
 * NOTE ON PERSISTED CANDLE HISTORY
 * For real out-of-sample and walk-forward testing (60/20/20 split across
 * a long history), you'll want a candles table (symbol, tf, time, open,
 * high, low, close) populated once from Delta Exchange's historical
 * candle REST endpoint and kept in sync going forward — separate from
 * the in-memory `feed.buffers` used for the live chart. That's a
 * deltaFeed.js + db.js change; send those two files over and I'll wire
 * it in next, plus the train/validate/test splitter described in the spec.
 */
