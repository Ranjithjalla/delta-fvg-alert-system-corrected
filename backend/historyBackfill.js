/*
 * historyBackfill.js
 *
 * Populates the persisted `candles` table (added to db.js) by paging
 * through Delta Exchange's historical candle REST endpoint, using the
 * SAME fetchCandles() function deltaFeed.js already uses for live
 * backfill/reconnect gap repair. No second HTTP client, no re-guessed
 * request format.
 *
 * This is additive only:
 *   - Does not touch DeltaFeed / the live WebSocket path.
 *   - Does not touch feed.buffers (still REST_LIMIT-bounded, for the chart).
 *   - Only writes to the new `candles` table via db.js's upsertCandles(),
 *     which is idempotent (safe to re-run / resume).
 *
 * USAGE
 *   node historyBackfill.js --tf 5m --days 180
 *   node historyBackfill.js --tf all --days 365
 *
 * NOTES
 *   - Chunk size (CHUNK_CANDLES) is conservative on purpose — Delta's
 *     REST history endpoint, like most exchange candle APIs, caps rows
 *     per request. 1000 is a safe starting point; lower it if you see
 *     truncated responses, raise it if you confirm the API allows more.
 *   - A small delay between requests (REQUEST_DELAY_MS) avoids hitting
 *     rate limits during a long backfill.
 *   - Must be run in an environment with real network access to
 *     REST_BASE (this was written and syntax-checked, but not executed
 *     against live Delta data — I don't have outbound network access
 *     in this sandbox).
 */

'use strict';

const { fetchCandles, TF_CONFIG, TF_ORDER, SYMBOL } = require('./deltaFeed');
const { upsertCandles, getCandleBounds } = require('./db');

const CHUNK_CANDLES = Number(process.env.BACKFILL_CHUNK_CANDLES || 1000);
const REQUEST_DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 300);

function parseArgs(argv) {
  const out = { tf: '5m', days: 180 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--tf') out.tf = argv[++i];
    else if (argv[i] === '--days') out.days = Number(argv[++i]);
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillTimeframe(symbol, tf, sinceMs, untilMs) {
  const cfg = TF_CONFIG[tf];
  const chunkMs = cfg.ms * CHUNK_CANDLES;

  let cursor = sinceMs;
  let totalWritten = 0;
  let totalFetched = 0;

  console.log(`[${tf}] backfilling from ${new Date(sinceMs).toISOString()} to ${new Date(untilMs).toISOString()}`);

  while (cursor < untilMs) {
    const chunkEnd = Math.min(cursor + chunkMs, untilMs);

    let rows;
    try {
      rows = await fetchCandles(symbol, tf, cursor, chunkEnd);
    } catch (err) {
      console.error(`[${tf}] fetch failed for ${new Date(cursor).toISOString()}..${new Date(chunkEnd).toISOString()}: ${err.message}`);
      // Back off and retry this same window once before giving up on it.
      await sleep(REQUEST_DELAY_MS * 5);
      try {
        rows = await fetchCandles(symbol, tf, cursor, chunkEnd);
      } catch (err2) {
        console.error(`[${tf}] retry failed, skipping window: ${err2.message}`);
        cursor = chunkEnd;
        continue;
      }
    }

    if (rows.length) {
      const written = upsertCandles(symbol, tf, rows);
      totalWritten += written;
      totalFetched += rows.length;
    }

    console.log(`[${tf}] ${new Date(cursor).toISOString()} -> ${new Date(chunkEnd).toISOString()}: ${rows.length} candles`);

    cursor = chunkEnd;
    await sleep(REQUEST_DELAY_MS);
  }

  const bounds = getCandleBounds(symbol, tf);
  console.log(`[${tf}] done. fetched ${totalFetched}, stored ${totalWritten}. DB now has ${bounds.count} candles (${bounds.minTime ? new Date(bounds.minTime).toISOString() : 'n/a'} -> ${bounds.maxTime ? new Date(bounds.maxTime).toISOString() : 'n/a'})`);
}

async function main() {
  const { tf, days } = parseArgs(process.argv);
  const symbol = SYMBOL;
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;

  const tfs = tf === 'all' ? TF_ORDER : [tf];
  for (const t of tfs) {
    if (!TF_CONFIG[t]) {
      console.error(`Unknown timeframe: ${t}. Valid: ${TF_ORDER.join(', ')}, or "all".`);
      process.exit(1);
    }
  }

  for (const t of tfs) {
    await backfillTimeframe(symbol, t, sinceMs, untilMs);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
