const TF_MINUTES = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240
};

const WICK_MIN_PCT = 0.05;
const C2_BODY_MIN_PCT = 0.60;

function body(c) {
  return Math.abs(c.close - c.open);
}

function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}

function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

/*
 * C2 displacement rule:
 * C2 body must be >= 60% of the total C2 candle range.
 *
 * IMPORTANT:
 * C2 is NOT subject to the 5% wick rule.
 */
function c2DisplacementOk(c) {
  const range = c.high - c.low;
  const b = body(c);

  if (range <= 0) return false;

  return b >= range * C2_BODY_MIN_PCT;
}

/*
 * All three candles must:
 * - be closed candles
 * - be non-doji
 * - have the same direction/color
 */
function sameColor3(c1, c2, c3) {
  if (
    c1.open === c1.close ||
    c2.open === c2.close ||
    c3.open === c3.close
  ) {
    return false;
  }

  const bull = c1.close > c1.open;

  return (
    (c2.close > c2.open) === bull &&
    (c3.close > c3.open) === bull
  );
}

/*
 * 5% wick rule.
 *
 * This rule is used ONLY for C1 and C3.
 *
 * side:
 *   'upper' -> upper wick
 *   'lower' -> lower wick
 */
function wickOk(c, side) {
  const b = body(c);

  if (b <= 0) return false;

  const wick =
    side === 'upper'
      ? upperWick(c)
      : lowerWick(c);

  return wick >= b * WICK_MIN_PCT;
}

function zoneId(symbol, tf, c1, direction) {
  return `${symbol}_${tf}_${c1.time}_${direction.toUpperCase()}`;
}

/*
 * Build an FVG from exactly three CLOSED candles.
 *
 * Rules:
 *
 * C1:
 *   relevant wick >= 5% of body
 *
 * C2:
 *   body >= 60% of total range
 *   NO 5% wick requirement
 *
 * C3:
 *   relevant wick >= 5% of body
 *
 * Bullish:
 *   C3 low > C1 high
 *
 * Bearish:
 *   C3 high < C1 low
 *
 * FVG boundaries use the WICKS of C1 and C3.
 */
function fvgFromThree(c1, c2, c3, symbol, tf) {
  // All three must be same-color, non-doji candles.
  if (!sameColor3(c1, c2, c3)) {
    return null;
  }

  // C2 must satisfy displacement requirement.
  // C2 is NOT checked by wickOk().
  if (!c2DisplacementOk(c2)) {
    return null;
  }

  let direction;
  let upperPrice;
  let lowerPrice;

  /*
   * BULLISH FVG
   *
   * C3 low > C1 high
   *
   * C1 -> upper wick
   * C3 -> lower wick
   */
  if (
    c1.high < c3.low &&
    wickOk(c1, 'upper') &&
    wickOk(c3, 'lower')
  ) {
    direction = 'bullish';

    lowerPrice = c1.high;
    upperPrice = c3.low;
  }

  /*
   * BEARISH FVG
   *
   * C3 high < C1 low
   *
   * C1 -> lower wick
   * C3 -> upper wick
   */
  else if (
    c1.low > c3.high &&
    wickOk(c1, 'lower') &&
    wickOk(c3, 'upper')
  ) {
    direction = 'bearish';

    lowerPrice = c3.high;
    upperPrice = c1.low;
  }

  else {
    return null;
  }

  if (!(upperPrice > lowerPrice)) {
    return null;
  }

  return {
    id: zoneId(symbol, tf, c1, direction),

    symbol,
    timeframe: tf,
    direction,

    c1Time: c1.time,
    c2Time: c2.time,
    c3Time: c3.time,

    time: c3.time,
    creationTime: c3.time,

    upperPrice,
    lowerPrice,

    gapSize: upperPrice - lowerPrice,

    status: 'ACTIVE',

    isIFVG: false,
    ifvgDirection: null
  };
}

/*
 * Evolve an FVG through candles that occurred after formation.
 *
 * invRule:
 *   'close' -> inversion based on candle close
 *   otherwise -> inversion based on wick
 *
 * fillRule:
 *   'touch'
 *   '50'
 *   'full'
 */
function evolveZone(
  zone,
  candlesAfter,
  invRule = 'close',
  fillRule = 'full'
) {
  const z = { ...zone };

  for (const c of candlesAfter) {
    const intrudes =
      c.low <= z.upperPrice &&
      c.high >= z.lowerPrice;

    /*
     * Normal FVG
     */
    if (!z.isIFVG) {
      let reverseBreak = false;

      if (invRule === 'close') {
        reverseBreak =
          z.direction === 'bullish'
            ? c.close < z.lowerPrice
            : c.close > z.upperPrice;
      }

      else {
        reverseBreak =
          z.direction === 'bullish'
            ? c.low < z.lowerPrice
            : c.high > z.upperPrice;
      }

      /*
       * FVG has been inverted into IFVG.
       */
      if (reverseBreak) {
        z.isIFVG = true;

        z.ifvgDirection =
          z.direction === 'bullish'
            ? 'bearish'
            : 'bullish';

        z.status = 'IFVG';

        continue;
      }

      /*
       * Price entered the FVG.
       */
      if (
        intrudes &&
        z.status === 'ACTIVE'
      ) {
        z.status = 'PARTIALLY_FILLED';
      }

      const mid =
        (z.upperPrice + z.lowerPrice) / 2;

      let filled = false;

      /*
       * Touch rule
       */
      if (
        fillRule === 'touch' &&
        intrudes
      ) {
        filled = true;
      }

      /*
       * 50% mitigation rule
       */
      if (fillRule === '50') {
        filled =
          z.direction === 'bullish'
            ? c.low <= mid
            : c.high >= mid;
      }

      /*
       * Full mitigation rule
       */
      if (fillRule === 'full') {
        filled =
          z.direction === 'bullish'
            ? c.low <= z.lowerPrice
            : c.high >= z.upperPrice;
      }

      if (filled) {
        z.status = 'FILLED';
      }
    }

    /*
     * IFVG
     */
    else {
      const mitigated =
        invRule === 'close'
          ? (
              z.ifvgDirection === 'bearish'
                ? c.close > z.upperPrice
                : c.close < z.lowerPrice
            )
          : (
              z.ifvgDirection === 'bearish'
                ? c.high > z.upperPrice
                : c.low < z.lowerPrice
            );

      if (mitigated) {
        z.status = 'MITIGATED';
      }
    }
  }

  return z;
}

/*
 * Detect all historical FVGs/IFVGs.
 */
function detectZones(
  candles,
  symbol,
  tf,
  opts = {}
) {
  const zones = [];

  const invRule =
    opts.invRule || 'close';

  const fillRule =
    opts.fillRule || 'full';

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    if (!sameColor3(c1, c2, c3)) {
      continue;
    }

    const base =
      fvgFromThree(
        c1,
        c2,
        c3,
        symbol,
        tf
      );

    if (!base) {
      continue;
    }

    const zone =
      evolveZone(
        base,
        candles.slice(i + 1),
        invRule,
        fillRule
      );

    zones.push(zone);
  }

  return zones;
}

/*
 * Find newly formed FVG from the latest
 * three CLOSED candles.
 *
 * IMPORTANT:
 * This only detects formation.
 * Alerting/retrace logic is handled elsewhere.
 */
function findNewClosedFvgs(
  candles,
  symbol,
  tf
) {
  if (candles.length < 3) {
    return [];
  }

  const i = candles.length - 1;

  const base =
    fvgFromThree(
      candles[i - 2],
      candles[i - 1],
      candles[i],
      symbol,
      tf
    );

  return base ? [base] : [];
}

/*
 * Check whether live price is inside the FVG zone.
 */
function priceTouchesZone(price, zone) {
  return (
    price >= zone.lowerPrice &&
    price <= zone.upperPrice
  );
}

/*
 * Apply live price to an active zone.
 */
function applyLivePrice(zone, price) {
  const z = { ...zone };

  /*
   * Don't modify already completed zones.
   */
  if (
    z.isIFVG ||
    z.status === 'MITIGATED' ||
    z.status === 'FILLED'
  ) {
    return z;
  }

  /*
   * Live retrace/touch.
   */
  if (priceTouchesZone(price, z)) {
    z.status = 'PARTIALLY_FILLED';
  }

  return z;
}

module.exports = {
  TF_MINUTES,

  WICK_MIN_PCT,
  C2_BODY_MIN_PCT,

  body,
  upperWick,
  lowerWick,

  c2DisplacementOk,

  sameColor3,
  wickOk,

  fvgFromThree,
  evolveZone,
  detectZones,
  findNewClosedFvgs,

  priceTouchesZone,
  applyLivePrice
};