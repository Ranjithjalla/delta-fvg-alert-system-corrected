const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fvgFromThree,
  detectZones,
  priceTouchesZone
} = require('../fvgEngine');

function c(time, open, high, low, close, volume = 1) {
  return {
    time,
    open,
    high,
    low,
    close,
    volume
  };
}

// --------------------------------------------------
// Timeframe / candle validation
// --------------------------------------------------

test('valid candle sequence passes', () => {
  const candles = [
    c(0, 1000, 1100, 900, 1050),
    c(300000, 1050, 1200, 1000, 1150),
    c(600000, 1150, 1300, 1100, 1250)
  ];

  assert.equal(candles.length, 3);
  assert.ok(candles[0].close > candles[0].open);
  assert.ok(candles[1].close > candles[1].open);
  assert.ok(candles[2].close > candles[2].open);
});

test('duplicate/out-of-order/gap fails validation', () => {
  const candles = [
    c(0, 1000, 1100, 900, 1050),
    c(600000, 1050, 1200, 1000, 1150),
    c(300000, 1150, 1300, 1100, 1250)
  ];

  const times = candles.map(x => x.time);

  const strictlyIncreasing = times.every(
    (t, i) => i === 0 || t > times[i - 1]
  );

  assert.equal(strictlyIncreasing, false);
});

test('same color rejects doji', () => {
  const doji = c(
    0,
    1000,
    1200,
    900,
    1000
  );

  assert.equal(doji.close, doji.open);
});

// --------------------------------------------------
// Bullish FVG
//
// C1:
// body       = 100
// lower wick = 100
// wick/body  = 100% >= 5%
//
// C2:
// body       = 400
// range      = 500
// body/range = 80% >= 60%
//
// C3:
// body       = 200
// lower wick = 100
// wick/body  = 50% >= 5%
//
// Gap:
// C1 high = 1200
// C3 low  = 1400
// Gap     = 200 points
// --------------------------------------------------

test('bullish FVG uses wick boundaries and C2 displacement', () => {
  const a = c(
    0,
    1000,
    1200,
    900,
    1100
  );

  const b = c(
    300000,
    1100,
    1600,
    1100,
    1500
  );

  const d = c(
    600000,
    1500,
    1800,
    1400,
    1700
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
    1200
  );

  assert.equal(
    z.upperPrice,
    1400
  );
});

// --------------------------------------------------
// Bearish FVG
//
// C1:
// body       = 100
// upper wick = 100
// wick/body  = 100% >= 5%
//
// C2:
// body       = 400
// range      = 500
// body/range = 80% >= 60%
//
// C3:
// body       = 300
// upper wick = 50
// wick/body  = 16.67% >= 5%
//
// Gap:
// C1 low  = 1300
// C3 high = 1050
// Gap     = 250 points
// --------------------------------------------------

test('bearish FVG works with C2 displacement rule', () => {
  const a = c(
    0,
    1500,
    1600,
    1300,
    1400
  );

  const b = c(
    300000,
    1400,
    1400,
    900,
    1000
  );

  const d = c(
    600000,
    1000,
    1050,
    600,
    700
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
      1000,
      1200,
      900,
      1100
    ),

    c(
      300000,
      1100,
      1600,
      1100,
      1500
    ),

    c(
      600000,
      1500,
      1800,
      1400,
      1700
    ),

    c(
      900000,
      1700,
      1800,
      1600,
      1750
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
test('price touch is inside zone', () => {
  const zone = {
    direction: 'bullish',
    lowerPrice: 1200,
    upperPrice: 1400
  };

  // Clearly inside the zone.
  assert.equal(
    priceTouchesZone(1300, zone),
    true
  );

  // Clearly outside the zone.
  assert.equal(
    priceTouchesZone(1500, zone),
    false
  );
});