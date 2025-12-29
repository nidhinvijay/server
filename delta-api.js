/**
 * Delta Exchange API - Order Placement for SHORT trades
 * This handles live order execution on Delta Exchange demo account
 */

const crypto = require('crypto');
const https = require('https');

// Configuration - will be loaded from environment
const DELTA_API_KEY = process.env.DELTA_SHORT_API_KEY;
const DELTA_API_SECRET = process.env.DELTA_SHORT_API_SECRET;
const DELTA_BASE_URL = 'https://cdn-ind.testnet.deltaex.org';  // Bharath's working testnet URL

/**
 * Generate signature for Delta API authentication
 */
function generateSignature(method, endpoint, timestamp, body = '') {
  const message = method + timestamp + endpoint + body;
  return crypto
    .createHmac('sha256', DELTA_API_SECRET)
    .update(message)
    .digest('hex');
}

/**
 * Make authenticated request to Delta API
 */
function deltaRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyString = body ? JSON.stringify(body) : '';
    const signature = generateSignature(method, endpoint, timestamp, bodyString);

    const url = new URL(DELTA_BASE_URL + endpoint);
    
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'api-key': DELTA_API_KEY,
        'timestamp': timestamp,
        'signature': signature,
        'User-Agent': 'nidhin-server/1.0'
      }
    };

    if (bodyString) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            console.error('[Delta API] Error response:', parsed);
            reject(new Error(`Delta API error: ${res.statusCode} - ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Delta API parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    
    if (bodyString) {
      req.write(bodyString);
    }
    req.end();
  });
}

/**
 * Known product IDs (from Bharath's config)
 */
const KNOWN_PRODUCTS = {
  BTCUSD: 84
};

/**
 * Get product ID for a symbol (e.g., BTCUSD)
 */
async function getProductId(symbol) {
  // First check hardcoded IDs
  if (KNOWN_PRODUCTS[symbol]) {
    return KNOWN_PRODUCTS[symbol];
  }
  
  try {
    const response = await deltaRequest('GET', '/v2/products');
    const products = response.result || response;
    const product = products.find(p => 
      p.symbol === symbol || 
      p.underlying_asset?.symbol === symbol.replace('USD', '')
    );
    return product ? product.id : null;
  } catch (err) {
    console.error('[Delta API] Failed to get product ID:', err.message);
    return null;
  }
}

/**
 * Place a market order on Delta Exchange
 * @param {string} symbol - e.g., 'BTCUSD'
 * @param {string} side - 'buy' or 'sell'
 * @param {number} size - Contract size (in USD)
 * @returns {Promise<object>} Order result
 */
async function placeMarketOrder(symbol, side, size) {
  console.log(`[Delta API] Placing ${side.toUpperCase()} order: ${symbol}, size: $${size}`);
  
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    throw new Error('Delta API credentials not configured. Set DELTA_SHORT_API_KEY and DELTA_SHORT_API_SECRET');
  }

  // Get product ID
  const productId = await getProductId(symbol);
  if (!productId) {
    throw new Error(`Product not found: ${symbol}`);
  }

  const order = {
    product_id: productId,
    size: Math.abs(size),  // Positive size
    side: side.toLowerCase(),
    order_type: 'market_order'
  };

  try {
    const result = await deltaRequest('POST', '/v2/orders', order);
    console.log(`[Delta API] ✅ Order placed:`, result);
    return result;
  } catch (err) {
    console.error(`[Delta API] ❌ Order failed:`, err.message);
    throw err;
  }
}

/**
 * Place SHORT entry order (SELL to open)
 */
async function openShortPosition(symbol, sizeUsd) {
  return await placeMarketOrder(symbol, 'sell', sizeUsd);
}

/**
 * Close SHORT position (BUY to close)
 */
async function closeShortPosition(symbol, sizeUsd) {
  return await placeMarketOrder(symbol, 'buy', sizeUsd);
}

/**
 * Get current positions
 */
async function getPositions() {
  try {
    const result = await deltaRequest('GET', '/v2/positions');
    return result.result || result;
  } catch (err) {
    console.error('[Delta API] Failed to get positions:', err.message);
    return [];
  }
}

/**
 * Get wallet balance
 */
async function getBalance() {
  try {
    const result = await deltaRequest('GET', '/v2/wallet/balances');
    return result.result || result;
  } catch (err) {
    console.error('[Delta API] Failed to get balance:', err.message);
    return null;
  }
}

/**
 * Test API connection - call this first to verify credentials work
 */
async function testConnection() {
  console.log('[Delta API] Testing connection...');
  console.log('[Delta API] API Key:', DELTA_API_KEY ? `${DELTA_API_KEY.slice(0, 8)}...` : 'NOT SET');
  console.log('[Delta API] Base URL:', DELTA_BASE_URL);
  
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    console.error('[Delta API] ❌ Credentials not set!');
    return { success: false, error: 'Credentials not configured' };
  }
  
  try {
    // Test 1: Get products (public endpoint)
    console.log('[Delta API] Testing products endpoint...');
    const products = await deltaRequest('GET', '/v2/products');
    console.log('[Delta API] ✅ Products loaded:', (products.result || products).length, 'products');
    
    // Test 2: Get balance (authenticated endpoint)
    console.log('[Delta API] Testing authenticated endpoint...');
    const balance = await getBalance();
    console.log('[Delta API] ✅ Balance loaded:', balance);
    
    return { success: true, products: (products.result || products).length, balance };
  } catch (err) {
    console.error('[Delta API] ❌ Test failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  placeMarketOrder,
  openShortPosition,
  closeShortPosition,
  getPositions,
  getBalance,
  getProductId,
  testConnection
};
