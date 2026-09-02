const test = require('node:test');
const assert = require('node:assert/strict');
const { DeltaFeed, TF_CONFIG } = require('../deltaFeed');

function candle(time) { return { time, open:100, high:102, low:99, close:101, volume:1 }; }

test('live next candle is appended without duplication', async () => {
  const feed = new DeltaFeed('BTCUSD',()=>{},()=>{},()=>{});
  feed.buffers['5m'] = [candle(0)];
  await feed.handleCandle('5m', candle(300000));
  assert.deepEqual(feed.buffers['5m'].map(x=>x.time), [0,300000]);
});

test('same candle updates existing OHLC', async () => {
  const feed = new DeltaFeed('BTCUSD',()=>{},()=>{},()=>{});
  feed.buffers['5m'] = [candle(0)];
  const x = {...candle(0), close:105, high:106};
  await feed.handleCandle('5m', x);
  assert.equal(feed.buffers['5m'][0].close,105);
  assert.equal(feed.buffers['5m'][0].high,106);
});

test('older candle updates existing timestamp only', async () => {
  const feed = new DeltaFeed('BTCUSD',()=>{},()=>{},()=>{});
  feed.buffers['5m'] = [candle(0), candle(300000)];
  const x = {...candle(0), close:110};
  await feed.handleCandle('5m', x);
  assert.deepEqual(feed.buffers['5m'].map(x=>x.time), [0,300000]);
  assert.equal(feed.buffers['5m'][0].close,110);
});

test('missing live candle triggers backfill before current candle', async () => {
  const feed = new DeltaFeed('BTCUSD',()=>{},()=>{},()=>{});
  feed.buffers['5m'] = [candle(0), candle(300000)];
  feed.queueBackfill = async (tf, start, end) => {
    assert.equal(tf,'5m');
    assert.equal(start,600000);
    assert.equal(end,600000);
    feed.buffers[tf].push(candle(600000));
  };
  await feed.handleCandle('5m', candle(900000));
  assert.deepEqual(feed.buffers['5m'].map(x=>x.time), [0,300000,600000,900000]);
});

test('timeframe configuration is exact', () => {
  assert.equal(TF_CONFIG['5m'].ms,300000);
  assert.equal(TF_CONFIG['15m'].ms,900000);
  assert.equal(TF_CONFIG['1h'].ms,3600000);
  assert.equal(TF_CONFIG['4h'].ms,14400000);
});
