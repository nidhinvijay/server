const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "my-node-app",
          Accept: "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            const snippet = data ? ` - ${data.slice(0, 200)}` : "";
            return reject(
              new Error(
                `Delta REST error: ${res.statusCode} ${res.statusMessage || ""}${snippet}`.trim()
              )
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

function startDeltaRestPolling({
  io,
  logger = console,
  apiBase = "https://api.delta.exchange",
  symbol = "BTCUSD",
  eventName = "delta:rest",
  intervalMs = 1000,
}) {
  let timer = null;
  let lastPayload = null;

  async function poll() {
    try {
      const url = `${apiBase}/v2/tickers/${encodeURIComponent(symbol)}`;
      const response = await fetchJson(url);
      const dataNode = response.result || response.data || response;
      const priceRaw =
        dataNode.last_price ||
        dataNode.price ||
        dataNode.mark_price ||
        dataNode.close ||
        dataNode.ltp;
      const price = priceRaw !== undefined ? Number(priceRaw) : null;
      if (!Number.isFinite(price)) {
        return;
      }

      const payload = {
        exchange: "delta",
        symbol: dataNode.symbol || symbol,
        price,
        timestamp: response.timestamp
          ? new Date(response.timestamp).toISOString()
          : new Date().toISOString(),
        raw: response,
      };
      lastPayload = payload;
      io.emit(eventName, payload);
    } catch (err) {
      logger.error("Delta REST poll error:", err.message);
    }
  }

  timer = setInterval(poll, intervalMs);
  poll();

  io.on("connection", (socketClient) => {
    if (lastPayload) {
      socketClient.emit(eventName, lastPayload);
    }
  });

  return {
    getLastPayload: () => lastPayload,
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = { startDeltaRestPolling };
