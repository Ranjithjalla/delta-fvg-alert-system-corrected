const TF_MS = { '5m':300000, '15m':900000, '1h':3600000, '4h':14400000 };
function validateCandleSequence(candles, timeframe) {
  const ms = TF_MS[timeframe];
  const errors=[];
  if(!ms) return {ok:false,errors:['unknown timeframe']};
  for(let i=0;i<candles.length;i++){
    const c=candles[i];
    if(![c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)){ errors.push(`invalid OHLC at index=${i}`); continue; }
    if(c.time % ms !== 0) errors.push(`unaligned timestamp at index=${i}: ${new Date(c.time).toISOString()}`);
    if(c.high<c.open || c.high<c.close || c.low>c.open || c.low>c.close || c.high<c.low) errors.push(`invalid OHLC relationship at index=${i}`);
    if(i>0){ const d=c.time-candles[i-1].time; if(d<=0) errors.push(`non-ascending timestamp at index=${i}`); else if(d!==ms) errors.push(`gap/duplicate between ${new Date(candles[i-1].time).toISOString()} and ${new Date(c.time).toISOString()}`); }
  }
  return {ok:errors.length===0,errors};
}
module.exports={TF_MS,validateCandleSequence};
