# Delta Exchange 24/7 FVG / IFVG Alert System

This is a real server-side market alert engine. Delta Exchange is the market-data source; the browser is only a dashboard.

## Verified Delta Exchange API used

For the India production API, the current official Delta documentation specifies:

- REST base: `https://api.india.delta.exchange`
- Historical OHLC: `GET /v2/history/candles`
- Required REST parameters: `resolution`, `symbol`, `start`, `end`
- REST timestamps: Unix seconds
- Maximum historical response: 2000 candles
- Public WebSocket: `wss://public-socket.india.delta.exchange`
- Public candlestick channels: `candlestick_1m`, `candlestick_3m`, `candlestick_5m`, `candlestick_15m`, `candlestick_1h`, `candlestick_4h`, etc.
- BTCUSD is the documented BTC perpetual-style product symbol.

The code subscribes directly to Delta's public `candlestick_5m`, `candlestick_15m`, `candlestick_1h`, `candlestick_4h`, and `ticker` channels. No TradingView scraping is used.

## Architecture

Delta REST -> historical initialization -> Delta public WebSocket -> server candle buffer -> server FVG/IFVG engine -> Telegram/Web Push -> dashboard

The browser does not own signal detection. Closing Chrome does not stop the backend.

## FVG rule implemented

A confirmed FVG requires three consecutive **closed**, same-color, non-doji candles.

Bullish:
`C1.high < C3.low`

Bearish:
`C1.low > C3.high`

The gap boundaries use the C1/C3 wick extremes and both defining wicks must be at least 5% of that candle's body. This matches the existing project's wick filter.

Formation itself is stored but does **not** send the retracement alert. The retracement alert fires when live Delta ticker price first enters/touches an active FVG zone. The database prevents a second alert for the same zone/event after restart.

IFVG is the same zone object changing state after an opposite-direction invalidation. It is not recreated on every WebSocket update.

## Candle integrity

The backend validates:

- chronological order
- timeframe alignment
- duplicate timestamps
- missing intervals
- finite OHLC values
- `high >= open/close`
- `low <= open/close`
- `high >= low`

If a live candle arrives with missing intervals, the backend calls Delta REST for the missing range, merges and deduplicates the candles, validates the repaired sequence, and only then inserts the live candle.

## Install locally

```bash
cd backend
npm install
npm run generate-vapid
```

Copy `.env.example` to `.env`, then set the generated VAPID values and Telegram values.

```bash
npm start
```

Open `http://localhost:3000`.

## Telegram credential safety

Only put the Telegram bot token in `.env`. If a bot token has ever been pasted into a chat, terminal log, GitHub repository, or screenshot, revoke it with BotFather and create a replacement before deploying.

## Web Push

1. Generate VAPID keys.
2. Put them in `.env`.
3. Open the site over HTTPS in production.
4. Click Enable push notifications.
5. The browser subscription is stored in SQLite.
6. The server sends the notification when the FVG retracement event occurs.

## 24/7 deployment

A true 24/7 Node WebSocket process requires an always-running server. A free web-service plan that sleeps is not a guarantee of continuous market monitoring.

Recommended production layout:

- VPS / always-on VM
- Node.js
- PM2 or systemd
- persistent disk for SQLite
- HTTPS reverse proxy for Web Push

Example PM2:

```bash
cd backend
npm install
npm install -g pm2
pm2 start server.js --name fvg-alert
pm2 save
pm2 startup
```

If you deploy on a platform with an ephemeral filesystem, move `DB_PATH` to its persistent volume or use PostgreSQL instead of SQLite.

## API

- `GET /api/candles?tf=5m`
- `GET /api/zones?tf=5m`
- `GET /api/zones?tf=5m&id=...`
- `GET /api/status`
- `GET /api/health`
- `GET /api/alerts`
- `GET /api/vapid-public-key`
- `POST /api/subscribe`
- `POST /api/unsubscribe`
- `GET /api/settings?userId=...`
- `PUT /api/settings`

## Tests

```bash
cd backend
npm test
```

The test suite covers candle validation, duplicate/out-of-order/gap handling, same-color/doji rejection, bullish/bearish FVG formation, no-repaint confirmation, price-zone touching, and live buffer gap repair.
