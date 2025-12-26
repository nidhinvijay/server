const WebSocket = require("ws");

function startDeltaWs({
  io,
  logger = console,
  url = "wss://socket.india.delta.exchange",
  symbol = "BTCUSD",
  channel = "all_trades",
  eventName = "delta:ws",
}) {
  let socket = null;
  let reconnectTimer = null;
  let lastPayload = null;
  let reconnectDelayMs = 1000;
  let lastLogTimeMs = 0;
  let messageCount = 0;
  const LOG_INTERVAL_MS = 60000; // Log every 60 seconds

  function connect() {
    socket = new WebSocket(url);

    socket.on("open", () => {
      reconnectDelayMs = 1000;
      messageCount = 0;
      const subscribeMsg = {
        type: "subscribe",
        payload: {
          channels: [
            {
              name: channel,
              symbols: [symbol],
            },
          ],
        },
      };
      socket.send(JSON.stringify(subscribeMsg));
      logger.log(`Delta WS connected: ${url} (${symbol}, ${channel})`);
    });

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (
          msg.type === "all_trades_snapshot" &&
          Array.isArray(msg.trades) &&
          msg.trades.length > 0
        ) {
          const latest = msg.trades[0];
          const price = Number(latest.price);
          if (!Number.isFinite(price)) return;

          const payload = {
            exchange: "delta",
            symbol: msg.symbol,
            price,
            timestamp: latest.timestamp
              ? new Date(latest.timestamp / 1000).toISOString()
              : new Date().toISOString(),
            raw: latest,
          };
          lastPayload = payload;
          io.emit(eventName, payload);
          messageCount++;
          
          // Only log first message or periodically
          const now = Date.now();
          if (messageCount === 1 || now - lastLogTimeMs >= LOG_INTERVAL_MS) {
            logger.log(`Delta LTP: ${msg.symbol} = ${price} (msgs: ${messageCount})`);
            lastLogTimeMs = now;
          }
          return;
        }

        if (msg.type === "all_trades" && msg.symbol && msg.price) {
          const price = Number(msg.price);
          if (!Number.isFinite(price)) return;

          const payload = {
            exchange: "delta",
            symbol: msg.symbol,
            price,
            timestamp: msg.timestamp
              ? new Date(msg.timestamp / 1000).toISOString()
              : new Date().toISOString(),
            raw: msg,
          };
          lastPayload = payload;
          io.emit(eventName, payload);
          messageCount++;
          
          // Only log periodically to reduce noise
          const now = Date.now();
          if (now - lastLogTimeMs >= LOG_INTERVAL_MS) {
            logger.log(`Delta LTP: ${msg.symbol} = ${price} (msgs: ${messageCount})`);
            lastLogTimeMs = now;
          }
        }
      } catch (err) {
        logger.error("Delta WS parse error:", err.message);
      }
    });

    socket.on("close", (code, reason) => {
      logger.warn(`Delta WS closed (${code}): ${reason || "no reason"}`);
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      logger.error("Delta WS error:", err.message);
      socket.close();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
      connect();
    }, reconnectDelayMs);
  }

  io.on("connection", (socketClient) => {
    if (lastPayload) socketClient.emit(eventName, lastPayload);
  });

  connect();
}

module.exports = { startDeltaWs };

