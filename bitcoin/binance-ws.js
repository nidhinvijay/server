const WebSocket = require("ws");

function startBinanceWs({
  io,
  tradingEngine = null,
  logger = console,
  symbol = "btcusdt",
  eventName = "binance:ws",
}) {
  let socket = null;
  let reconnectTimer = null;
  let lastPayload = null;
  let reconnectDelayMs = 1000;

  function connect() {
    const url = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    socket = new WebSocket(url);

    socket.on("open", () => {
      reconnectDelayMs = 1000;
      logger.log(`Binance WS connected: ${url}`);
    });

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const payload = {
          exchange: "binance",
          symbol: msg.s || symbol.toUpperCase(),
          price: Number(msg.p),
          timestamp: msg.E ? new Date(msg.E).toISOString() : new Date().toISOString(),
          raw: msg,
        };
        lastPayload = payload;
        io.emit(eventName, payload);
        
        // Feed price to trading engine for PnL calculations
        if (tradingEngine) {
          tradingEngine.updateLtp(payload.symbol, payload.price);
        }
      } catch (err) {
        logger.error("Binance WS parse error:", err.message);
      }
    });

    socket.on("close", (code, reason) => {
      logger.warn(`Binance WS closed (${code}): ${reason || "no reason"}`);
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      logger.error("Binance WS error:", err.message);
      socket.close();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
      connect();
    }, reconnectDelayMs);
  }

  io.on("connection", (socketClient) => {
    if (lastPayload) {
      socketClient.emit(eventName, lastPayload);
    }
  });

  connect();

  return {
    getLastPayload: () => lastPayload,
    close: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close();
      }
    },
  };
}

module.exports = { startBinanceWs };
