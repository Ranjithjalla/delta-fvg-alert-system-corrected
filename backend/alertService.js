const fetch = require('node-fetch');
const webpush = require('web-push');
const { db } = require('./db');

let configured = false;
function configure() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    configured = true;
  }
}
function fmt(n) { return Number(n).toFixed(2); }
function directionLabel(zone) { return zone.isIFVG ? `${zone.ifvgDirection} IFVG` : `${zone.direction} FVG`; }
function liquidityLabel(x) { return x.side === 'buy' ? 'BUY-SIDE LIQUIDITY' : 'SELL-SIDE LIQUIDITY'; }
function eventText(zone, eventType) {
  if (eventType === 'LIQUIDITY_SWEEP') {
    const side = liquidityLabel(zone);
    const bias = zone.side === 'buy' ? 'BEARISH REJECTION' : 'BULLISH REJECTION';
    return `🚨 ${zone.timeframe.toUpperCase()} ${side} SWEPT\nBias: ${bias}\nSymbol: ${zone.symbol}\nLiquidity: ${fmt(zone.price)}\nSweep: ${fmt(zone.sweepPrice)}\nQuality: ${fmt(zone.sweepQuality || 0)}\nTouches: ${zone.touches || 1}${zone.equal ? ' (EQUAL LIQUIDITY)' : ''}`;
  }
  if (eventType === 'FVG_RETRACE') return `🚨 ${zone.timeframe.toUpperCase()} ${directionLabel(zone)} touched\nSymbol: ${zone.symbol}\nZone: ${fmt(zone.lowerPrice)} - ${fmt(zone.upperPrice)}\nCreated: ${new Date(zone.creationTime).toISOString()}`;
  return `⚠️ ${zone.timeframe.toUpperCase()} FVG → ${zone.ifvgDirection.toUpperCase()} IFVG\nSymbol: ${zone.symbol}\nZone: ${fmt(zone.lowerPrice)} - ${fmt(zone.upperPrice)}\nCreated: ${new Date(zone.creationTime).toISOString()}`;
}
function settingsAllow(s, zone, eventType) {
  if (!s || !s.push_enabled) return false;
  if (!s[`tf_${zone.timeframe}`]) return false;
  if (eventType === 'LIQUIDITY_SWEEP') return zone.side === 'buy' ? !!s.liquidity_buy : !!s.liquidity_sell;
  if (eventType === 'IFVG_FLIP') return zone.ifvgDirection === 'bullish' ? !!s.bull_ifvg : !!s.bear_ifvg;
  return zone.direction === 'bullish' ? !!s.bull_fvg : !!s.bear_fvg;
}
function getUserIds() { return db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map(r => r.user_id); }
function getSettings(userId) {
  return db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(userId) || {
    user_id:userId,push_enabled:1,tf_5m:1,tf_15m:1,tf_1h:1,tf_4h:1,bull_fvg:1,bear_fvg:1,bull_ifvg:1,bear_ifvg:1,liquidity_buy:1,liquidity_sell:1
  };
}

async function sendTelegramAlert(zone, eventType, onLog) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ chat_id: chatId, text:eventText(zone,eventType) }) });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
  onLog('[ALERT] Telegram sent');
  return { ok:true, messageId:json.result && json.result.message_id };
}

async function sendPush(zone, eventType, onLog) {
  if (!configured) return { sent:0, skipped:true };
  let sent = 0;
  for (const userId of getUserIds()) {
    const settings = getSettings(userId);
    if (!settingsAllow(settings, zone, eventType)) continue;
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint:sub.endpoint, keys:{p256dh:sub.p256dh,auth:sub.auth} }, JSON.stringify({
          title: eventType === 'LIQUIDITY_SWEEP' ? `🚨 ${zone.timeframe.toUpperCase()} ${liquidityLabel(zone)} swept` : (eventType === 'FVG_RETRACE' ? `🚨 ${zone.timeframe.toUpperCase()} ${directionLabel(zone)} touched` : `⚠️ ${zone.timeframe.toUpperCase()} IFVG`),
          body: eventType === 'LIQUIDITY_SWEEP' ? `${zone.symbol}\n${fmt(zone.price)} → ${fmt(zone.sweepPrice)}\nQuality ${fmt(zone.sweepQuality || 0)}` : `${zone.symbol}\n${fmt(zone.lowerPrice)} - ${fmt(zone.upperPrice)}`,
          url:eventType === 'LIQUIDITY_SWEEP' ? `/?tf=${zone.timeframe}&liqId=${encodeURIComponent(zone.id)}` : `/?tf=${zone.timeframe}&fvgId=${encodeURIComponent(zone.id)}`,
          fvgId:eventType === 'LIQUIDITY_SWEEP' ? undefined : zone.id,
          liquidityId:eventType === 'LIQUIDITY_SWEEP' ? zone.id : undefined
        }));
        sent++;
        onLog('[PUSH] Web push sent');
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
        else onLog('[PUSH] delivery failed: ' + err.message);
      }
    }
  }
  return { sent };
}

async function sendAlert(zone, eventType, onLog) {
  // DB uniqueness makes the event one-shot across restarts.
  const inserted = db.prepare('INSERT OR IGNORE INTO alert_events(zone_id,event_type,created_at) VALUES(?,?,?)').run(zone.id,eventType,Date.now());
  if (!inserted.changes) return { deduped:true };
  const results = {};
  try { results.telegram = await sendTelegramAlert(zone,eventType,onLog); } catch (e) { results.telegram={ok:false,error:e.message}; onLog('[ALERT] Telegram failed: '+e.message); }
  try { results.push = await sendPush(zone,eventType,onLog); } catch (e) { results.push={sent:0,error:e.message}; onLog('[PUSH] failed: '+e.message); }
  return results;
}

module.exports = { configure, sendAlert, getSettings };
