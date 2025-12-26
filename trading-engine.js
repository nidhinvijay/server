/**
 * Trading Engine - Server-side Paper/Live Trade Management
 * 
 * Supports LONG and SHORT positions independently:
 * - BUY signal → Open LONG (if not already open)
 * - SELL signal → Open SHORT (if not already open)
 * 
 * Each position has its own paper trades, live trades, and PnL tracking.
 */

const LIVE_WEBHOOK_URL = 'https://asia-south1-delta-6c4a8.cloudfunctions.net/tradingviewWebhook?token=tradingview';

// Thresholds (updated per user request)
const OPEN_THRESHOLD = 0;   // Activate live when profit > $0
const CLOSE_THRESHOLD = 0;  // Protective close when profit <= $0

class TradingEngine {
  constructor(io) {
    this.io = io;
    
    // LONG position state
    this.longState = {
      paperTrade: null,        // Current open paper trade
      liveState: this.createLiveState(),
      signals: []
    };
    
    // SHORT position state
    this.shortState = {
      paperTrade: null,        // Current open paper trade
      liveState: this.createLiveState(),
      signals: []
    };
    
    // Shared
    this.ltpBySymbol = new Map();
    this.fsmBySymbol = new Map();
    
    // Broadcast state every 1 second
    setInterval(() => {
      this.broadcastState();
    }, 1000);
    
    console.log('[TradingEngine] Initialized with LONG/SHORT support');
  }

  createLiveState() {
    return {
      state: 'NO_POSITION',
      cumulativePnl: 0,
      unrealizedPnl: 0,
      blockedAtMs: null,
      openTrade: null,
      trades: []
    };
  }

  // --- STATE GETTERS ---
  
  getFullState() {
    return {
      long: {
        paperTrade: this.longState.paperTrade,
        liveState: this.serializeLiveState(this.longState.liveState),
        signals: this.longState.signals.slice(0, 20)
      },
      short: {
        paperTrade: this.shortState.paperTrade,
        liveState: this.serializeLiveState(this.shortState.liveState),
        signals: this.shortState.signals.slice(0, 20)
      },
      ltp: Object.fromEntries(this.ltpBySymbol),
      fsm: Object.fromEntries(this.fsmBySymbol)
    };
  }

  serializeLiveState(state) {
    const totalPnl = state.cumulativePnl + state.unrealizedPnl;
    return {
      state: state.state,
      cumulativePnl: state.cumulativePnl,
      unrealizedPnl: state.unrealizedPnl,
      isLiveActive: totalPnl > OPEN_THRESHOLD,
      blockedAtMs: state.blockedAtMs,
      openTrade: state.openTrade,
      trades: state.trades.slice(0, 20)
    };
  }

  broadcastState() {
    this.io.emit('engine_state', this.getFullState());
  }

  // --- PRICE UPDATES ---
  
  updateLtp(symbol, price) {
    this.ltpBySymbol.set(symbol, price);
    
    // Update LONG position
    if (this.longState.paperTrade && this.longState.paperTrade.symbol === symbol) {
      const trade = this.longState.paperTrade;
      trade.currentPrice = price;
      // LONG: profit when price goes UP
      trade.unrealizedPnl = (price - trade.entryPrice) * trade.quantity;
      
      const totalPnl = this.longState.liveState.cumulativePnl + trade.unrealizedPnl;
      this.checkLiveTrade('LONG', this.longState, totalPnl, price, symbol);
    }
    
    // Update SHORT position
    if (this.shortState.paperTrade && this.shortState.paperTrade.symbol === symbol) {
      const trade = this.shortState.paperTrade;
      trade.currentPrice = price;
      // SHORT: profit when price goes DOWN
      trade.unrealizedPnl = (trade.entryPrice - price) * trade.quantity;
      
      const totalPnl = this.shortState.liveState.cumulativePnl + trade.unrealizedPnl;
      this.checkLiveTrade('SHORT', this.shortState, totalPnl, price, symbol);
    }
  }

  // --- WEBHOOK SIGNAL PROCESSING ---
  
  processWebhookSignal(signal) {
    const { symbol, intent, stoppx, side } = signal;
    if (!symbol) return;
    
    const normalizedSymbol = symbol.toUpperCase();
    const ltp = this.ltpBySymbol.get(normalizedSymbol);
    const entryPrice = ltp || stoppx;
    
    // Determine direction from side or intent
    const isBuy = side === 'BUY' || intent === 'ENTRY';
    const isSell = side === 'SELL' || intent === 'EXIT';
    
    const signalRecord = {
      timeIst: this.formatIstTime(new Date()),
      intent: isBuy ? 'BUY' : 'SELL',
      stoppx,
      ltp: ltp || null,
      receivedAt: Date.now()
    };
    
    if (isBuy) {
      // BUY = Open LONG (if not already open)
      this.longState.signals.unshift(signalRecord);
      this.longState.signals = this.longState.signals.slice(0, 50);
      
      if (!this.longState.paperTrade) {
        this.openPaperTrade('LONG', this.longState, normalizedSymbol, entryPrice);
      } else {
        console.log(`[TradingEngine] LONG already open, ignoring BUY signal`);
      }
    } else if (isSell) {
      // SELL = Open SHORT (if not already open)
      this.shortState.signals.unshift(signalRecord);
      this.shortState.signals = this.shortState.signals.slice(0, 50);
      
      if (!this.shortState.paperTrade) {
        this.openPaperTrade('SHORT', this.shortState, normalizedSymbol, entryPrice);
      } else {
        console.log(`[TradingEngine] SHORT already open, ignoring SELL signal`);
      }
    }
    
    // Update FSM
    this.fsmBySymbol.set(normalizedSymbol, {
      state: isBuy ? 'BUYPOSITION' : 'SELLPOSITION',
      threshold: stoppx
    });
    
    this.broadcastState();
  }

  openPaperTrade(direction, state, symbol, entryPrice) {
    const trade = {
      id: `paper-${direction}-${symbol}-${Date.now()}`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      direction,
      entryPrice,
      currentPrice: entryPrice,
      quantity: 2,
      unrealizedPnl: 0
    };
    
    state.paperTrade = trade;
    console.log(`[TradingEngine] � ${direction} Paper ENTRY: ${symbol} @ ${entryPrice}`);
    
    // Store pending for live activation
    state.liveState.pendingPaperTrade = { 
      entryPrice, 
      quantity: 2, 
      lot: 1,
      direction 
    };
  }

  // --- LIVE TRADE MANAGEMENT ---
  
  checkLiveTrade(direction, state, totalPnl, currentPrice, symbol) {
    const liveState = state.liveState;
    
    // Check if block expired
    if (liveState.blockedAtMs && this.isFirstSecondNextMinute(liveState.blockedAtMs, Date.now())) {
      liveState.blockedAtMs = null;
      console.log(`[TradingEngine] 🔓 ${direction} Block expired`);
    }
    
    // Protective close: when PnL drops to <= 0
    if (liveState.state === 'POSITION' && liveState.openTrade && totalPnl <= CLOSE_THRESHOLD) {
      console.log(`[TradingEngine] 🛡️ ${direction} Protective close: PnL ${totalPnl.toFixed(2)} <= ${CLOSE_THRESHOLD}`);
      this.closeLiveTrade(direction, state, currentPrice, 'Protective', symbol);
      liveState.blockedAtMs = Date.now();
    }
    
    // Activate: when PnL > 0 and not blocked
    if (liveState.state === 'NO_POSITION' && liveState.pendingPaperTrade && !liveState.blockedAtMs && totalPnl > OPEN_THRESHOLD) {
      console.log(`[TradingEngine] 🚀 ${direction} Live activation: PnL ${totalPnl.toFixed(2)} > ${OPEN_THRESHOLD}`);
      this.openLiveTrade(direction, state, currentPrice, symbol);
    }
    
    // Update unrealized for live state
    if (liveState.openTrade) {
      if (direction === 'LONG') {
        liveState.unrealizedPnl = (currentPrice - liveState.openTrade.entryPrice) * liveState.openTrade.quantity * liveState.openTrade.lot;
      } else {
        liveState.unrealizedPnl = (liveState.openTrade.entryPrice - currentPrice) * liveState.openTrade.quantity * liveState.openTrade.lot;
      }
    }
  }

  async openLiveTrade(direction, state, entryPrice, symbol) {
    const liveState = state.liveState;
    
    const trade = {
      id: `live-${direction}-${symbol}-${Date.now()}`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      direction,
      action: 'ENTRY',
      entryPrice,
      exitPrice: null,
      quantity: 2,
      lot: 1,
      realizedPnl: null,
      cumulativePnl: liveState.cumulativePnl
    };
    
    liveState.openTrade = trade;
    liveState.state = 'POSITION';
    liveState.trades.unshift({ ...trade });
    
    console.log(`[TradingEngine] ✅ ${direction} LIVE ENTRY: ${symbol} @ ${entryPrice}`);
    
    // Send to external webhook
    const signalType = direction === 'LONG' ? 'ENTRY' : 'SHORT_ENTRY';
    await this.sendLiveSignal(signalType, symbol, entryPrice);
    this.broadcastState();
  }

  async closeLiveTrade(direction, state, exitPrice, reason, symbol) {
    const liveState = state.liveState;
    if (!liveState.openTrade) return;
    
    let realizedPnl;
    if (direction === 'LONG') {
      realizedPnl = (exitPrice - liveState.openTrade.entryPrice) * liveState.openTrade.quantity * liveState.openTrade.lot;
    } else {
      realizedPnl = (liveState.openTrade.entryPrice - exitPrice) * liveState.openTrade.quantity * liveState.openTrade.lot;
    }
    
    liveState.cumulativePnl += realizedPnl;
    
    const exitTrade = {
      id: `${liveState.openTrade.id}-exit`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      direction,
      action: 'EXIT',
      entryPrice: liveState.openTrade.entryPrice,
      exitPrice,
      quantity: liveState.openTrade.quantity,
      realizedPnl,
      cumulativePnl: liveState.cumulativePnl
    };
    
    liveState.trades.unshift(exitTrade);
    liveState.openTrade = null;
    liveState.state = 'NO_POSITION';
    liveState.unrealizedPnl = 0;
    
    console.log(`[TradingEngine] ✅ ${direction} LIVE EXIT (${reason}): ${symbol} @ ${exitPrice}, PnL: $${realizedPnl.toFixed(2)}`);
    
    const signalType = direction === 'LONG' ? 'EXIT' : 'SHORT_EXIT';
    await this.sendLiveSignal(signalType, symbol, exitPrice);
    this.broadcastState();
  }

  async sendLiveSignal(kind, symbol, refPrice) {
    const mappedSymbol = symbol === 'BTCUSDT' ? 'BTCUSD' : symbol;
    
    const message = kind.includes('ENTRY')
      ? `Accepted Entry + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${mappedSymbol}`
      : `Accepted Exit + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${mappedSymbol}`;
    
    try {
      const response = await fetch(LIVE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const result = await response.text();
      console.log(`[TradingEngine] 📡 Live signal sent: ${kind} ${mappedSymbol} @ ${refPrice}`);
    } catch (err) {
      console.error(`[TradingEngine] ❌ Failed to send live signal:`, err.message);
    }
  }

  // --- HELPERS ---
  
  isFirstSecondNextMinute(blockedAtMs, nowMs) {
    const blockedMinute = Math.floor(blockedAtMs / 60000);
    const currentMinute = Math.floor(nowMs / 60000);
    const currentSecond = Math.floor((nowMs % 60000) / 1000);
    return currentMinute > blockedMinute && currentSecond < 2;
  }

  formatIstTime(date) {
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }
}

module.exports = { TradingEngine };
