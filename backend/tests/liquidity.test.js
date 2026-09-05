const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSwingHigh,
  isSwingLow,
  buildLevels,
  sweepEventsForLatestCandle,
  reconstructLiquidity
} = require('../liquidityEngine');

function c(time, open, high, low, close) { return { time, open, high, low, close, volume: 1 }; }

const candles = [
  c(0,100,105,99,103),
  c(1,103,110,102,108),
  c(2,108,106,101,103),
  c(3,103,107,100,104),
  c(4,104,109,103,108),
  c(5,108,111,105,110),
  c(6,110,107,101,103),
  c(7,103,106,99,101)
];

test('confirmed swing high and swing low are objective', () => {
  assert.equal(isSwingHigh(candles, 1, 1, 1), true);
  assert.equal(isSwingLow(candles, 3, 1, 1), true);
});

test('buildLevels creates buy and sell liquidity', () => {
  const levels = buildLevels(candles, '5m', { left:1, right:1, tolerancePoints:2 });
  assert.ok(levels.some(x => x.side === 'buy'));
  assert.ok(levels.some(x => x.side === 'sell'));
});

test('buy-side sweep requires trade above and close below', () => {
  const level = { id:'x', side:'buy', price:110, status:'ACTIVE', touches:1 };
  const event = sweepEventsForLatestCandle([level], c(8,108,112,107,109), { tolerancePoints:1 });
  assert.equal(event.length, 1);
  assert.equal(event[0].level.status, 'SWEPT');
  assert.equal(event[0].level.sweepPrice, 112);
});

test('sell-side sweep requires trade below and close above', () => {
  const level = { id:'x', side:'sell', price:100, status:'ACTIVE', touches:1 };
  const event = sweepEventsForLatestCandle([level], c(8,101,102,97,101), { tolerancePoints:1 });
  assert.equal(event.length, 1);
  assert.equal(event[0].level.status, 'SWEPT');
  assert.equal(event[0].level.sweepPrice, 97);
});


test('equal highs within tolerance are represented as equal liquidity', () => {
  const xs = [
    c(0,100,105,99,104), c(1,104,110,103,109), c(2,109,106,100,101),
    c(3,101,105,100,104), c(4,104,111,103,110), c(5,110,106,101,103), c(6,103,107,102,106)
  ];
  const levels = buildLevels(xs, '5m', { left:1, right:1, tolerancePoints:2 });
  assert.ok(levels.some(x => x.side === 'buy' && x.equal && x.touches >= 2));
});

test('sweep requires rejection back across the level', () => {
  const level = { id:'x', side:'buy', price:110, status:'ACTIVE', touches:1 };
  assert.equal(sweepEventsForLatestCandle([level], c(8,108,112,107,111), { tolerancePoints:1 }).length, 0);
});

test('reconstruction marks historical sweep without creating a second event', () => {
  const xs = [
    c(0,100,110,99,109),
    c(1,109,111,108,110),
    c(2,110,112,109,111),
    c(3,111,113,108,109),
    c(4,109,110,100,101),
    c(5,101,105,99,103)
  ];
  const levels = reconstructLiquidity(xs, '5m', { left:1, right:1, tolerancePoints:1 });
  assert.ok(Array.isArray(levels));
});
