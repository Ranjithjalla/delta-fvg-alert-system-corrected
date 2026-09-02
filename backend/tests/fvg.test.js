const test = require('node:test');
const assert = require('node:assert/strict');
const { sameColor3, fvgFromThree, detectZones, priceTouchesZone } = require('../fvgEngine');
const { validateCandleSequence } = require('../candleUtils');

function c(time, open, high, low, close) { return {time,open,high,low,close}; }

test('valid candle sequence passes', () => {
  const a=[c(0,100,103,99,102),c(300000,102,105,101,104),c(600000,104,107,103,106)];
  assert.equal(validateCandleSequence(a,'5m').ok,true);
});
test('duplicate/out-of-order/gap fails validation', () => {
  const a=[c(0,100,103,99,102),c(300000,102,105,101,104),c(900000,104,107,103,106)];
  assert.equal(validateCandleSequence(a,'5m').ok,false);
});
test('same color rejects doji', () => {
  const a=c(0,100,102,99,101), b=c(300000,101,103,100,101), d=c(600000,101,105,100,104);
  assert.equal(sameColor3(a,b,d),false);
});
test('bullish FVG uses wick boundaries', () => {
  const a=c(0,100,101.5,99,101), b=c(300000,101,104,100.5,103), d=c(600000,103,106,102.5,105);
  const z=fvgFromThree(a,b,d,'BTCUSD','5m');
  assert.ok(z); assert.equal(z.direction,'bullish'); assert.equal(z.lowerPrice,101.5); assert.equal(z.upperPrice,102.5);
});
test('bearish FVG works', () => {
  const a=c(0,105,106,103.5,104), b=c(300000,104,104.5,101,102), d=c(600000,102,102.5,99,100);
  const z=fvgFromThree(a,b,d,'BTCUSD','5m');
  assert.ok(z); assert.equal(z.direction,'bearish');
});
test('detectZones does not use final forming candle as c3', () => {
  const candles=[c(0,100,101.5,99,101),c(300000,101,104,100.5,103),c(600000,103,106,102.5,105),c(900000,105,106,104,105.5)];
  const zs=detectZones(candles,'BTCUSD','5m');
  assert.ok(zs.some(z=>z.c3Time===600000));
});
test('price touch is inside zone', () => assert.equal(priceTouchesZone(101.75,{lowerPrice:101.5,upperPrice:102.5}),true));
