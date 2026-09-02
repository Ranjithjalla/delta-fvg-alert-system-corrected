const TF_MINUTES = { '5m': 5, '15m': 15, '1h': 60, '4h': 240 };
const WICK_MIN_PCT = 0.05;

function body(c) { return Math.abs(c.close - c.open); }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function sameColor3(c1, c2, c3) {
  if (c1.open === c1.close || c2.open === c2.close || c3.open === c3.close) return false;
  const bull = c1.close > c1.open;
  return (c2.close > c2.open) === bull && (c3.close > c3.open) === bull;
}
function wickOk(c, side) {
  const b = body(c);
  if (b <= 0) return false;
  return (side === 'upper' ? upperWick(c) : lowerWick(c)) >= b * WICK_MIN_PCT;
}
function zoneId(symbol, tf, c1, direction) {
  return `${symbol}_${tf}_${c1.time}_${direction.toUpperCase()}`;
}
function fvgFromThree(c1, c2, c3, symbol, tf) {
  if (!sameColor3(c1, c2, c3)) return null;
  let direction, upperPrice, lowerPrice;
  if (c1.high < c3.low && wickOk(c1, 'upper') && wickOk(c3, 'lower')) {
    direction = 'bullish'; lowerPrice = c1.high; upperPrice = c3.low;
  } else if (c1.low > c3.high && wickOk(c1, 'lower') && wickOk(c3, 'upper')) {
    direction = 'bearish'; lowerPrice = c3.high; upperPrice = c1.low;
  } else return null;
  if (!(upperPrice > lowerPrice)) return null;
  return {
    id: zoneId(symbol, tf, c1, direction), symbol, timeframe: tf, direction,
    c1Time: c1.time, c2Time: c2.time, c3Time: c3.time, time: c3.time,
    creationTime: c3.time, upperPrice, lowerPrice, gapSize: upperPrice - lowerPrice,
    status: 'ACTIVE', isIFVG: false, ifvgDirection: null
  };
}

function evolveZone(zone, candlesAfter, invRule = 'close', fillRule = 'full') {
  const z = { ...zone };
  for (const c of candlesAfter) {
    const intrudes = c.low <= z.upperPrice && c.high >= z.lowerPrice;
    if (!z.isIFVG) {
      let reverseBreak = false;
      if (invRule === 'close') {
        reverseBreak = z.direction === 'bullish' ? c.close < z.lowerPrice : c.close > z.upperPrice;
      } else {
        reverseBreak = z.direction === 'bullish' ? c.low < z.lowerPrice : c.high > z.upperPrice;
      }
      if (reverseBreak) {
        z.isIFVG = true;
        z.ifvgDirection = z.direction === 'bullish' ? 'bearish' : 'bullish';
        z.status = 'IFVG';
        continue;
      }
      if (intrudes && z.status === 'ACTIVE') z.status = 'PARTIALLY_FILLED';
      const mid = (z.upperPrice + z.lowerPrice) / 2;
      let filled = false;
      if (fillRule === 'touch' && intrudes) filled = true;
      if (fillRule === '50') filled = z.direction === 'bullish' ? c.low <= mid : c.high >= mid;
      if (fillRule === 'full') filled = z.direction === 'bullish' ? c.low <= z.lowerPrice : c.high >= z.upperPrice;
      if (filled) z.status = 'FILLED';
    } else {
      const mitigated = invRule === 'close'
        ? (z.ifvgDirection === 'bearish' ? c.close > z.upperPrice : c.close < z.lowerPrice)
        : (z.ifvgDirection === 'bearish' ? c.high > z.upperPrice : c.low < z.lowerPrice);
      if (mitigated) z.status = 'MITIGATED';
    }
  }
  return z;
}

function detectZones(candles, symbol, tf, opts = {}) {
  const zones = [];
  const invRule = opts.invRule || 'close';
  const fillRule = opts.fillRule || 'full';
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (!sameColor3(c1, c2, c3)) continue;
    const base = fvgFromThree(c1, c2, c3, symbol, tf);
    if (!base) continue;
    const zone = evolveZone(base, candles.slice(i + 1), invRule, fillRule);
    zones.push(zone);
  }
  return zones;
}

function findNewClosedFvgs(candles, symbol, tf) {
  if (candles.length < 3) return [];
  const i = candles.length - 1;
  const base = fvgFromThree(candles[i - 2], candles[i - 1], candles[i], symbol, tf);
  return base ? [base] : [];
}

function priceTouchesZone(price, zone) {
  return price >= zone.lowerPrice && price <= zone.upperPrice;
}

function applyLivePrice(zone, price) {
  const z = { ...zone };
  if (z.isIFVG || z.status === 'MITIGATED' || z.status === 'FILLED') return z;
  if (priceTouchesZone(price, z)) z.status = 'PARTIALLY_FILLED';
  return z;
}

module.exports = {
  TF_MINUTES, WICK_MIN_PCT, body, upperWick, lowerWick, sameColor3,
  wickOk, fvgFromThree, evolveZone, detectZones, findNewClosedFvgs,
  priceTouchesZone, applyLivePrice
};
