const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sameColor3,
  fvgFromThree,
  detectZones,
  priceTouchesZone
} = require('../fvgEngine');

const {
  validateCandleSequence
} = require('../candleUtils');

function c(time, open, high, low, close) {
  return {
    time,
    open,
    high,
    low,
    close
  };
}


// --------------------------------------------------
// Candle sequence validation
// --------------------------------------------------

test('valid candle sequence passes', () => {
  const a = [
    c(0, 100, 103, 99, 102),
    c(300000, 102, 105, 101, 104),
    c(600000, 104, 107, 103, 106)
  ];

  assert.equal(
    validateCandleSequence(a, '5m').ok,
    true
  );
});


test('duplicate/out-of-order/gap fails validation', () => {
  const a = [
    c(0, 100, 103, 99, 102),
    c(300000, 102, 105, 101, 104),
    c(900000, 104, 107, 103, 106)
  ];

  assert.equal(
    validateCandleSequence(a, '5m').ok,
    false
  );
});


// --------------------------------------------------
// Candle color / doji
// --------------------------------------------------

test('same color rejects doji', () => {
  const a = c(
    0,
    100,
    102,
    99,
    101
  );

  const b = c(
    300000,
    101,
    103,
    100,
    101
  );

  const d = c(
    600000,
    101,
    105,
    100,
    104
  );

  assert.equal(
    sameColor3(a, b, d),
    false
  );
});


// --------------------------------------------------
// Bullish FVG
//
// C1:
// body = 1
// upper wick = 0.5
// 0.5 / 1 = 50% >= 5%
//
// C2:
// body = 2
// total range = 3
// 2 / 3 = 66.67% >= 60%
//
// C3:
// body = 2
// lower wick = 0.5
// 0.5 / 2 = 25% >= 5%
//
// Gap:
// C1 high = 101.5
// C3 low  = 102.5
// --------------------------------------------------

test('bullish FVG uses wick boundaries and C2 displacement', () => {
  const a = c(
    0,
    100,
    101.5,
    99,
    101
  );

  const b = c(
    300000,
    101,
    104,
    101,
    103
  );

  const d = c(
    600000,
    103,
    106,
    102.5,
    105
  );

  const z = fvgFromThree(
    a,
    b,
    d,
    'BTCUSD',
    '5m'
  );

  assert.ok(z);

  assert.equal(
    z.direction,
    'bullish'
  );

  assert.equal(
    z.lowerPrice,
    101.5
  );

  assert.equal(
    z.upperPrice,
    102.5
  );
});


// --------------------------------------------------
// Bearish FVG
//
// C1:
// body = 1
// lower wick = 0.5
// 50% >= 5%
//
// C2:
// body = 2
// total range = 3
// 66.67% >= 60%
//
// C3:
// body = 2
// upper wick = 0.5
// 25% >= 5%
//
// Gap:
// C3 high = 102.5
// C1 low  = 103.5
// --------------------------------------------------

test('bearish FVG works with C2 displacement rule', () => {
  const a = c(
    0,
    105,
    106,
    103.5,
    104
  );

  const b = c(
    300000,
    104,
    104.5,
    101.5,
    102
  );

  const d = c(
    600000,
    102,
    102.5,
    99,
    100
  );

  const z = fvgFromThree(
    a,
    b,
    d,
    'BTCUSD',
    '5m'
  );

  assert.ok(z);

  assert.equal(
    z.direction,
    'bearish'
  );
});


// --------------------------------------------------
// detectZones
// --------------------------------------------------

test('detectZones detects valid FVG ending at c3', () => {
  const candles = [
    c(
      0,
      100,
      101.5,
      99,
      101
    ),

    c(
      300000,
      101,
      104,
      101,
      103
    ),

    c(
      600000,
      103,
      106,
      102.5,
      105
    ),

    c(
      900000,
      105,
      106,
      104,
      105.5
    )
  ];

  const zs = detectZones(
    candles,
    'BTCUSD',
    '5m'
  );

  assert.ok(
    zs.some(
      z => z.c3Time === 600000
    )
  );
});


// --------------------------------------------------
// Price touch
// --------------------------------------------------

test(
  'price touch is inside zone',
  () => {
    assert.equal(
      priceTouchesZone(
        101.75,
        {
          lowerPrice: 101.5,
          upperPrice: 102.5
        }
      ),
      true
    );
  }
);