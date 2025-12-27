const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const { KiteConnect, KiteTicker } = require("kiteconnect");
const { startBinanceWs } = require("./bitcoin/binance-ws");
const { startDeltaWs } = require("./bitcoin/delta-ws");
const { startDeltaRestPolling } = require("./bitcoin/delta-rest");
const { TradingEngine } = require("./trading-engine");
//node .\scripts\rewrite-env.js
function loadEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const apiKey = process.env.KITE_API_KEY;
const accessToken = process.env.KITE_ACCESS_TOKEN;
const instrumentsRaw = process.env.INSTRUMENTS_DATA;

if (!apiKey || !accessToken || !instrumentsRaw) {
  console.error("Missing KITE_API_KEY, KITE_ACCESS_TOKEN, or INSTRUMENTS_DATA in .env");
  process.exit(1);
}

let instruments;
try {
  instruments = JSON.parse(instrumentsRaw);
} catch (err) {
  console.error("INSTRUMENTS_DATA must be valid JSON. Run: node scripts/rewrite-env.js");
  console.error(err.message);
  process.exit(1);
}

if (!Array.isArray(instruments) || instruments.length === 0) {
  console.error("INSTRUMENTS_DATA must be a non-empty JSON array");
  process.exit(1);
}

const tokens = instruments
  .map((instrument) => instrument.token)
  .filter((token) => Number.isFinite(token));

if (tokens.length === 0) {
  console.error("No valid numeric tokens found in INSTRUMENTS_DATA");
  process.exit(1);
}

const port = process.env.SOCKET_PORT
  ? Number(process.env.SOCKET_PORT)
  : 3001;

// Global references (initialized after server setup)
let io = null;
let tradingEngine = null;

const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: "text/plain" }));

// Serve Angular static files from /public folder
app.use(express.static(path.join(__dirname, 'public')));


function normalizeWebhookPayload(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed);
    } catch (err) {
      const parsed = {};
      const [prefix, rest] = trimmed.split("+").map((part) => part.trim());
      if (prefix) {
        parsed.action = prefix.replace(/^Accepted\s+/i, "").trim();
      }

      const kvSource = rest || trimmed;
      const kvPairs = kvSource.split(/[|,\n]/);
      for (const pair of kvPairs) {
        const idx = pair.indexOf("=");
        if (idx === -1) {
          continue;
        }
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key) {
          parsed[key] = value;
        }
      }
      return parsed;
    }
  }

  return {};
}

function extractTradeSignal(payload) {
  const symbol = payload.symbol || payload.ticker || payload.sym || null;
  const stopPxRaw =
    payload.stoppx || payload.stopPx || payload.stop_price || payload.stopPrice || null;
  const stoppx = stopPxRaw !== null && stopPxRaw !== undefined ? Number(stopPxRaw) : null;
  const actionRaw = String(
    payload.action || payload.side || payload.signal || payload.order_type || payload.type || ""
  )
    .trim()
    .toUpperCase();

  const isEntry =
    actionRaw.includes("ENTRY") ||
    payload.entry === true ||
    payload.isEntry === true ||
    String(payload.entry || payload.isEntry || "")
      .toLowerCase()
      .includes("true");
  const isExit =
    actionRaw.includes("EXIT") ||
    payload.exit === true ||
    payload.isExit === true ||
    String(payload.exit || payload.isExit || "")
      .toLowerCase()
      .includes("true");

  let side = null;
  if (actionRaw.includes("BUY") || actionRaw.includes("LONG")) {
    side = "BUY";
  } else if (actionRaw.includes("SELL") || actionRaw.includes("SHORT")) {
    side = "SELL";
  }

  if (!side) {
    if (isEntry) {
      side = "BUY";
    } else if (isExit) {
      side = "SELL";
    }
  }

  return {
    symbol,
    stoppx: Number.isFinite(stoppx) ? stoppx : null,
    intent: isEntry ? "ENTRY" : isExit ? "EXIT" : null,
    side,
    raw: payload,
  };
}

app.post("/webhook", (req, res) => {
  const payload = normalizeWebhookPayload(req);
  const signal = extractTradeSignal(payload);
  lastWebhookSignal = signal;
  console.log("TradingView webhook:", signal);
  
  // Broadcast to connected clients
  if (io) io.emit("webhook", signal);
  
  // Process in trading engine
  if (tradingEngine) tradingEngine.processWebhookSignal(signal);
  
  res.json({ ok: true, received: signal });
});

const { execSync } = require('child_process');

// Helper to update .env
function writeZerodhaEnv({ envPath, apiKey, apiSecret, accessToken }) {
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  }

  const lines = content.split(/\r?\n/);
  const newLines = [];
  const keysFound = new Set();
  const keysToUpdate = {
    KITE_API_KEY: apiKey,
    KITE_API_SECRET: apiSecret,
    KITE_ACCESS_TOKEN: accessToken,
  };

  for (const line of lines) {
    const start = line.trim();
    if (!start || start.startsWith("#")) {
      newLines.push(line);
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      newLines.push(line);
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (keysToUpdate[key] !== undefined) {
      newLines.push(`${key}=${keysToUpdate[key]}`);
      keysFound.add(key);
    } else {
      newLines.push(line);
    }
  }

  // Append missing keys
  for (const [key, val] of Object.entries(keysToUpdate)) {
    if (!keysFound.has(key)) {
      newLines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(envPath, newLines.join("\n"));
}

/**
 * Zerodha Callback for Session Generation
 * Redirect URL: http://localhost:3001/zerodha/callback
 */
app.get('/zerodha/callback', async (req, res) => {
  const requestToken = String(req.query.request_token || '');
  
  if (!requestToken) {
    return res.status(400).send('Missing request_token');
  }

  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) {
    return res
      .status(500)
      .send('Server missing KITE_API_KEY / KITE_API_SECRET env vars');
  }

  // Use .env path by default
  const envPath = path.resolve(process.cwd(), '.env');

  try {
    const kc = new KiteConnect({ api_key: apiKey });
    const response = await kc.generateSession(requestToken, apiSecret);
    const accessToken = String(response.access_token || '');
    if (!accessToken) throw new Error('generateSession returned no access_token');

    writeZerodhaEnv({
      envPath,
      apiKey,
      apiSecret,
      accessToken,
    });

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Zerodha Session</title></head>
<body style="font-family: Arial, sans-serif; margin: 20px;">
  <h2>Zerodha session updated</h2>
  <p><b>Env path:</b> <code>${envPath}</code></p>
  <p><b>Action:</b> Server restarting in 1 second...</p>
  <p style="font-size: 12px; color: #555;">
    Access token written successfully. You can close this tab.
  </p>
</body></html>`;
    
    // Send response FIRST
    res.status(200).send(html);

    // Restart process AFTER response is sent (1s delay)
    const pmId = process.env.pm_id; // PM2 automatically sets this
    const pm2Name = process.env.ZERODHA_PM2_NAME ?? 'simplelogic-backend'; 
    const doRestart = process.env.ZERODHA_PM2_RESTART !== '0';

    if (doRestart) {
      setTimeout(() => {
        try {
          console.log('🔄 Triggering Self-Restart...');
          if (pmId) {
            execSync(`pm2 restart ${pmId}`, { stdio: 'ignore' });
          } else {
            execSync(`pm2 restart ${pm2Name}`, { stdio: 'ignore' });
          }
        } catch (e) {
          console.error('Restart failed:', e.message);
        }
      }, 1000);
    }
    
    return;
  } catch (e) {
    return res.status(500).send(`Failed to generate session: ${String(e)}`);
  }
});


// POST /live-signal - Forward live trading signals to Firebase cloud function
const LIVE_WEBHOOK_URL = 'https://asia-south1-delta-6c4a8.cloudfunctions.net/tradingviewWebhook?token=tradingview';

app.post("/live-signal", async (req, res) => {
  console.log("[live-signal] 📩 Received payload:", JSON.stringify(req.body, null, 2));
  try {
    let { kind, symbol, refPrice } = req.body;

    // Validate required fields
    if (!kind || !symbol || refPrice === undefined) {
      console.error("[live-signal] Missing required fields");
      return res.status(400).json({ error: "Missing kind, symbol, or refPrice" });
    }

    // Map BTCUSDT -> BTCUSD
    if (symbol === 'BTCUSDT') {
      symbol = 'BTCUSD';
    }
    
    // Build TradingView-style message
    const message = kind === 'ENTRY'
      ? `Accepted Entry + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`
      : `Accepted Exit + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`;
    
    console.log(`[live-signal] 🚀 Forwarding ${kind} signal to Firebase:`, { symbol, refPrice });
    
    const response = await fetch(LIVE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    
    const result = await response.text();
    console.log(`[live-signal] ✅ Firebase response:`, result);
    
    res.json({ ok: true, forwarded: { kind, symbol, refPrice }, response: result });
  } catch (err) {
    console.error(`[live-signal] ❌ Failed:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const server = http.createServer(app);
io = new Server(server, {
  cors: { origin: "*" },
});

// Initialize Trading Engine
tradingEngine = new TradingEngine(io);

startBinanceWs({ io, tradingEngine });
startDeltaWs({ io });
startDeltaRestPolling({ io });

const ticker = new KiteTicker({
  api_key: apiKey,
  access_token: accessToken,
});

let firstTickLogged = false;
let firstTickCache = null;
let lastWebhookSignal = null;

io.on("connection", (socket) => {
  // Send cached data to new connections
  if (firstTickCache) {
    socket.emit("firstTick", firstTickCache);
  }
  if (lastWebhookSignal) {
    socket.emit("webhook", lastWebhookSignal);
  }
  
  // Send current trading engine state
  socket.emit("engine_state", tradingEngine.getFullState());
});

ticker.on("connect", () => {
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeFull, tokens);
});

ticker.on("ticks", (ticks) => {
  if (!firstTickLogged && Array.isArray(ticks) && ticks.length > 0) {
    const first = ticks[0];
    console.log(`Zerodha connected - First tick: token=${first.instrument_token} LTP=${first.last_price}`);
    firstTickCache = first;
    io.emit("firstTick", firstTickCache);
    firstTickLogged = true;
  }

  // Emit to clients
  io.emit("ticks", ticks);
  
  // Feed to trading engine for Options PnL calculations
  if (tradingEngine && Array.isArray(ticks)) {
    for (const tick of ticks) {
      // Use token as identifier for Zerodha instruments
      const tokenSymbol = `TOKEN-${tick.instrument_token}`;
      tradingEngine.updateLtp(tokenSymbol, tick.last_price);
    }
  }
});

ticker.on("error", (err) => {
  console.error("KiteTicker error:", err);
});

ticker.on("close", () => {
  console.log("KiteTicker closed");
});

ticker.on("reconnect", (reconnectAttempt) => {
  console.log("KiteTicker reconnect:", reconnectAttempt);
});

ticker.on("noreconnect", () => {
  console.log("KiteTicker noreconnect");
});

// Market Hours Scheduler (09:00 - 15:40 IST)
function checkMarketHoursAndConnect() {
   const now = new Date();
   // Convert to IST manually (UTC + 5hr 30min)
   const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
   const istOffset = 5.5 * 60 * 60 * 1000;
   const istDate = new Date(utc + istOffset);
   
   const hours = istDate.getHours();
   const minutes = istDate.getMinutes();
   const totalMinutes = hours * 60 + minutes;
   const day = istDate.getDay(); // 0=Sun, 6=Sat
   
   const startMinutes = 9 * 60;       // 09:00
   const endMinutes = 15 * 60 + 40;   // 15:40
   
   const isWeekday = day !== 0 && day !== 6;
   const isMarketOpen = isWeekday && totalMinutes >= startMinutes && totalMinutes < endMinutes;

   // Check internal KiteTicker connected state (underscore property is common hack, or rely on our events)
   // Better to just try/catch connect or disconnect based on need.
   // But we can track state via events. Using a global flag is safer.
   
   if (isMarketOpen) {
     if (!ticker.connected()) {
       console.log(`[Market Hours] 🟢 Open (09:00-15:40 IST). Connecting ticker... (${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')})`);
       ticker.connect();
     }
   } else {
     if (ticker.connected()) {
       console.log(`[Market Hours] 🔴 Closed. Disconnecting ticker... (${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')})`);
       ticker.disconnect();
     }
   }
}

// Initial check
checkMarketHoursAndConnect();

// Check every 1 minute
setInterval(checkMarketHoursAndConnect, 60000);

// SPA catch-all: Serve index.html for Angular routes
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Angular app not found. Copy dist files to /public folder.');
  }
});

server.listen(port, () => {
  console.log(`Socket.IO server listening on port ${port}`);
});
