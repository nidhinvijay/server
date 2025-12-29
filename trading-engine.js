/**
 * Trading Engine - Server-side Paper/Live Trade Management
 * 
 * FSM Logic (Breakout Strategy):
 * 
 * LONG (BUY signal):
 *   - Sets threshold = stoppx
 *   - State → NOPOSITION_SIGNAL (waiting)
 *   - When LTP > threshold → Entry! State → BUYPOSITION
 *   - While in position: LTP < threshold → Stop loss! State → NOPOSITION_BLOCKED
 * 
 * SHORT (SELL signal):
 *   - Sets threshold = stoppx
 *   - State → NOPOSITION_SIGNAL (waiting)
 *   - When LTP < threshold → Entry! State → SELLPOSITION
 *   - While in position: LTP > threshold → Stop loss! State → NOPOSITION_BLOCKED
 * 
 * BLOCKED:
 *   - Wait 1 minute before allowing re-entry
 */

const fs = require('fs');
const path = require('path');

const LIVE_WEBHOOK_URL = 'https://asia-south1-delta-6c4a8.cloudfunctions.net/tradingviewWebhook?token=tradingview';
const STATE_FILE = path.join(__dirname, 'trading-state.json');

// Thresholds for paper-to-live
const OPEN_THRESHOLD = 0;   // Activate live when profit > $0
const CLOSE_THRESHOLD = 0;  // Protective close when profit <= $0

// Position sizing
const POSITION_SIZE = 10;  // $10 position size (demo has only $100)

class TradingEngine {
  constructor(io) {
    this.io = io;
    
    // LONG position state
    this.longState = {
      fsmState: 'NOPOSITION',
      threshold: null,
      paperTrade: null,
      paperTrades: [],
      peakPnlHistory: [],      // History of peak PnL values
      currentPeakPnl: null,    // Current session peak
      liveState: this.createLiveState(),
      signals: [],
      lastSignalAtMs: null,
      lastBlockedAtMs: null
    };
    
    // SHORT position state
    this.shortState = {
      fsmState: 'NOPOSITION',
      threshold: null,
      paperTrade: null,
      paperTrades: [],
      peakPnlHistory: [],      // History of peak PnL values
      currentPeakPnl: null,    // Current session peak
      liveState: this.createLiveState(),
      signals: [],
      lastSignalAtMs: null,
      lastBlockedAtMs: null
    };
    
    // Shared
    this.ltpBySymbol = new Map();
    this.fsmBySymbol = new Map();
    this.lastResetDate = null;
    this.lastResetTimestamp = Date.now();  // Only sum trades after this for daily cumulative
    
    // Load persisted state if available
    this.loadState();
    
    // Broadcast state every 1 second + check for daily reset
    setInterval(() => {
      this.checkDailyReset();
      this.broadcastState();
    }, 1000);
    
    // Auto-save state every 60 seconds
    setInterval(() => {
      this.saveState();
    }, 60000);
    
    console.log('[TradingEngine] Initialized with FSM Breakout Logic');
  }

  // Check and perform daily reset at 5:30 AM IST
  checkDailyReset() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(utc + istOffset);
    
    const hours = istDate.getHours();
    const minutes = istDate.getMinutes();
    const dateStr = istDate.toISOString().split('T')[0];
    
    if (hours === 5 && minutes >= 30 && minutes < 31 && this.lastResetDate !== dateStr) {
      this.performDailyReset();
      this.lastResetDate = dateStr;
    }
  }

  performDailyReset() {
    console.log('[TradingEngine] 🔄 Daily reset at 5:30 AM IST');
    
    // Close any open positions first (this saves to history before clearing)
    if (this.longState.paperTrade) {
      const ltp = this.ltpBySymbol.get(this.longState.paperTrade.symbol) || this.longState.paperTrade.currentPrice;
      this.closePaperTrade('LONG', this.longState, ltp, 'Daily Reset');
    }
    if (this.shortState.paperTrade) {
      const ltp = this.ltpBySymbol.get(this.shortState.paperTrade.symbol) || this.shortState.paperTrade.currentPrice;
      this.closePaperTrade('SHORT', this.shortState, ltp, 'Daily Reset');
    }
    
    // Reset LONG - keep history, reset active state and PnL
    this.longState.fsmState = 'NOPOSITION';
    this.longState.threshold = null;
    this.longState.currentPeakPnl = null;
    this.longState.signals = [];  // Reset signals for new day
    this.longState.liveState.state = 'NO_POSITION';
    this.longState.liveState.cumulativePnl = 0;  // Reset PnL
    this.longState.liveState.unrealizedPnl = 0;
    this.longState.liveState.blockedAtMs = null;
    this.longState.liveState.openTrade = null;
    this.longState.liveState.pendingPaperTrade = null;
    // Keep: paperTrades, peakPnlHistory, liveState.trades
    this.longState.lastSignalAtMs = null;
    this.longState.lastBlockedAtMs = null;
    
    // Reset SHORT - keep history, reset active state and PnL
    this.shortState.fsmState = 'NOPOSITION';
    this.shortState.threshold = null;
    this.shortState.currentPeakPnl = null;
    this.shortState.signals = [];  // Reset signals for new day
    this.shortState.liveState.state = 'NO_POSITION';
    this.shortState.liveState.cumulativePnl = 0;  // Reset PnL
    this.shortState.liveState.unrealizedPnl = 0;
    this.shortState.liveState.blockedAtMs = null;
    this.shortState.liveState.openTrade = null;
    this.shortState.liveState.pendingPaperTrade = null;
    // Keep: paperTrades, peakPnlHistory, liveState.trades
    this.shortState.lastSignalAtMs = null;
    this.shortState.lastBlockedAtMs = null;
    
    this.fsmBySymbol.clear();
    this.lastResetTimestamp = Date.now();  // Update reset checkpoint for cumulative calculations
    console.log('[TradingEngine] ✅ Daily reset complete - History preserved, cumulative PnL reset');
    
    // Auto-generate signals for new day (after short delay to ensure LTP is available)
    setTimeout(() => {
      this.generateAutoSignals();
    }, 5000);  // 5 second delay to ensure LTP data is fresh
  }
  
  // Auto-generate BUY and SELL signals at 5:30 AM
  generateAutoSignals() {
    const ltp = this.ltpBySymbol.get('BTCUSDT');
    if (!ltp) {
      console.log('[TradingEngine] ⚠️ Auto-signals skipped - no LTP available');
      return;
    }
    
    const now = Date.now();
    
    // Generate BUY signal for LONG (threshold = LTP - 50)
    const buySignal = {
      symbol: 'BTCUSDT',
      stoppx: ltp - 50,
      intent: 'ENTRY',
      side: 'BUY',
      raw: { auto: true, timestamp: now, ltp }
    };
    console.log('[TradingEngine] 🤖 Auto BUY signal:', buySignal);
    this.processWebhookSignal(buySignal);
    
    // Generate SELL signal for SHORT (threshold = LTP)
    const sellSignal = {
      symbol: 'BTCUSDT',
      stoppx: ltp,
      intent: 'ENTRY',
      side: 'SELL',
      raw: { auto: true, timestamp: now, ltp }
    };
    console.log('[TradingEngine] 🤖 Auto SELL signal:', sellSignal);
    this.processWebhookSignal(sellSignal);
    
    console.log('[TradingEngine] ✅ Auto signals generated - LONG threshold:', ltp - 50, ', SHORT threshold:', ltp);
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
  
  // Calculate cumulative paper PnL = unrealized + sum of paper trades history (today only)
  getCumPaperPnl(state) {
    const unrealized = state.paperTrade?.unrealizedPnl || 0;
    // Only sum trades closed after last reset
    const realized = (state.paperTrades || []).reduce((sum, t) => {
      if (t.closedAt && t.closedAt > this.lastResetTimestamp) {
        return sum + (t.realizedPnl || 0);
      }
      return sum;
    }, 0);
    return unrealized + realized;
  }
  
  // Calculate cumulative live PnL = sum of realized PnL from live trades only (today only)
  getCumLivePnl(liveState) {
    return (liveState.trades || []).reduce((sum, t) => {
      // Only count EXIT trades after last reset
      if (t.action === 'EXIT' && t.realizedPnl !== null && t.closedAt && t.closedAt > this.lastResetTimestamp) {
        return sum + t.realizedPnl;
      }
      return sum;
    }, 0);
  }
  
  getFullState() {
    return {
      long: {
        fsmState: this.longState.fsmState,
        threshold: this.longState.threshold,
        paperTrade: this.longState.paperTrade,
        paperTrades: this.longState.paperTrades,
        peakPnlHistory: this.longState.peakPnlHistory,
        currentPeakPnl: this.longState.currentPeakPnl,
        liveState: this.serializeLiveState(this.longState.liveState),
        signals: this.longState.signals,
        cumPaperPnl: this.getCumPaperPnl(this.longState),
        cumLivePnl: this.getCumLivePnl(this.longState.liveState),
        paperTradeCount: (this.longState.paperTrades || []).length + (this.longState.paperTrade ? 1 : 0),
        liveTradeCount: (this.longState.liveState.trades || []).filter(t => t.action === 'EXIT').length + (this.longState.liveState.openTrade ? 1 : 0)
      },
      short: {
        fsmState: this.shortState.fsmState,
        threshold: this.shortState.threshold,
        paperTrade: this.shortState.paperTrade,
        paperTrades: this.shortState.paperTrades,
        peakPnlHistory: this.shortState.peakPnlHistory,
        currentPeakPnl: this.shortState.currentPeakPnl,
        liveState: this.serializeLiveState(this.shortState.liveState),
        signals: this.shortState.signals,
        cumPaperPnl: this.getCumPaperPnl(this.shortState),
        cumLivePnl: this.getCumLivePnl(this.shortState.liveState),
        paperTradeCount: (this.shortState.paperTrades || []).length + (this.shortState.paperTrade ? 1 : 0),
        liveTradeCount: (this.shortState.liveState.trades || []).filter(t => t.action === 'EXIT').length + (this.shortState.liveState.openTrade ? 1 : 0)
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
      trades: state.trades
    };
  }

  broadcastState() {
    this.io.emit('engine_state', this.getFullState());
  }

  // --- PRICE UPDATES (FSM Transitions) ---
  
  updateLtp(symbol, price) {
    this.ltpBySymbol.set(symbol, price);
    
    // Only process FSM transitions for BTC symbols
    const upperSymbol = symbol.toUpperCase();
    if (!upperSymbol.includes('BTC')) {
      return; // Ignore non-BTC ticks for trading logic
    }
    
    const now = Date.now();
    
    // Process LONG FSM transitions
    this.processLongTickTransition(symbol, price, now);
    
    // Process SHORT FSM transitions
    this.processShortTickTransition(symbol, price, now);
  }

  processLongTickTransition(symbol, ltp, now) {
    const state = this.longState;
    
    // Safety check: Reset FSM if trade is missing (can happen after restart)
    if ((state.fsmState === 'BUYPOSITION') && !state.paperTrade) {
      console.log('[TradingEngine] ⚠️ LONG state mismatch detected, resetting to NOPOSITION');
      state.fsmState = 'NOPOSITION';
      state.threshold = null;
      state.currentPeakPnl = null;  // Reset peak since no trade
    }
    
    // Update existing position PnL
    if (state.paperTrade && state.paperTrade.symbol === symbol) {
      state.paperTrade.currentPrice = ltp;
      // LONG: profit when price goes UP
      state.paperTrade.unrealizedPnl = (ltp - state.paperTrade.entryPrice) * state.paperTrade.quantity;
      
      // Track peak PnL - update if new high (positive only)
      const currentPnl = state.paperTrade.unrealizedPnl;
      if (currentPnl > 0 && (state.currentPeakPnl === null || currentPnl > state.currentPeakPnl)) {
        state.currentPeakPnl = currentPnl;
      }
      
      const totalPnl = state.liveState.cumulativePnl + state.paperTrade.unrealizedPnl;
      this.checkLiveTrade('LONG', state, totalPnl, ltp, symbol);
    }
    
    if (state.threshold === null) return;
    
    // FSM State transitions based on tick
    switch (state.fsmState) {
      case 'NOPOSITION_SIGNAL':
        // LONG: Enter when LTP breaks ABOVE threshold
        if (ltp > state.threshold) {
          console.log(`[TradingEngine] 📈 LONG ENTRY: LTP ${ltp} > threshold ${state.threshold}`);
          state.fsmState = 'BUYPOSITION';
          this.openPaperTrade('LONG', state, symbol, ltp);
        } else {
          console.log(`[TradingEngine] 🔒 LONG BLOCKED: LTP ${ltp} <= threshold ${state.threshold}`);
          state.fsmState = 'NOPOSITION_BLOCKED';
          state.lastBlockedAtMs = now;
        }
        break;
        
      case 'BUYPOSITION':
        // LONG: Stop loss when LTP drops BELOW threshold
        if (ltp < state.threshold) {
          console.log(`[TradingEngine] 🛑 LONG STOP LOSS: LTP ${ltp} < threshold ${state.threshold}`);
          this.closePaperTrade('LONG', state, ltp, 'Stop Loss');
          state.fsmState = 'NOPOSITION_BLOCKED';
          state.lastBlockedAtMs = now;
        }
        break;
        
      case 'NOPOSITION_BLOCKED':
        // Check if 1-minute lock expired
        if (state.lastBlockedAtMs && this.isFirstSecondNextMinute(state.lastBlockedAtMs, now)) {
          console.log(`[TradingEngine] 🔓 LONG UNBLOCKED after 1 minute`);
          // Re-check entry condition
          if (ltp > state.threshold) {
            console.log(`[TradingEngine] 📈 LONG RE-ENTRY: LTP ${ltp} > threshold ${state.threshold}`);
            state.fsmState = 'BUYPOSITION';
            this.openPaperTrade('LONG', state, symbol, ltp);
          } else {
            // Stay blocked, reset timer
            state.lastBlockedAtMs = now;
          }
        }
        break;
    }
    
    // Update FSM display
    this.fsmBySymbol.set(symbol + '_LONG', {
      state: state.fsmState,
      threshold: state.threshold
    });
  }

  processShortTickTransition(symbol, ltp, now) {
    const state = this.shortState;
    
    // Safety check: Reset FSM if trade is missing (can happen after restart)
    if ((state.fsmState === 'SELLPOSITION') && !state.paperTrade) {
      console.log('[TradingEngine] ⚠️ SHORT state mismatch detected, resetting to NOPOSITION');
      state.fsmState = 'NOPOSITION';
      state.threshold = null;
      state.currentPeakPnl = null;  // Reset peak since no trade
    }
    
    // Update existing position PnL
    if (state.paperTrade && state.paperTrade.symbol === symbol) {
      state.paperTrade.currentPrice = ltp;
      // SHORT: profit when price goes DOWN
      state.paperTrade.unrealizedPnl = (state.paperTrade.entryPrice - ltp) * state.paperTrade.quantity;
      
      // Track peak PnL - update if new high (positive only)
      const currentPnl = state.paperTrade.unrealizedPnl;
      if (currentPnl > 0 && (state.currentPeakPnl === null || currentPnl > state.currentPeakPnl)) {
        state.currentPeakPnl = currentPnl;
      }
      
      const totalPnl = state.liveState.cumulativePnl + state.paperTrade.unrealizedPnl;
      this.checkLiveTrade('SHORT', state, totalPnl, ltp, symbol);
    }
    
    if (state.threshold === null) return;
    
    // FSM State transitions based on tick
    switch (state.fsmState) {
      case 'NOPOSITION_SIGNAL':
        // SHORT: Enter when LTP breaks BELOW threshold
        if (ltp < state.threshold) {
          console.log(`[TradingEngine] 📉 SHORT ENTRY: LTP ${ltp} < threshold ${state.threshold}`);
          state.fsmState = 'SELLPOSITION';
          this.openPaperTrade('SHORT', state, symbol, ltp);
        } else {
          console.log(`[TradingEngine] 🔒 SHORT BLOCKED: LTP ${ltp} >= threshold ${state.threshold}`);
          state.fsmState = 'NOPOSITION_BLOCKED';
          state.lastBlockedAtMs = now;
        }
        break;
        
      case 'SELLPOSITION':
        // SHORT: Stop loss when LTP rises ABOVE threshold
        if (ltp > state.threshold) {
          console.log(`[TradingEngine] 🛑 SHORT STOP LOSS: LTP ${ltp} > threshold ${state.threshold}`);
          this.closePaperTrade('SHORT', state, ltp, 'Stop Loss');
          state.fsmState = 'NOPOSITION_BLOCKED';
          state.lastBlockedAtMs = now;
        }
        break;
        
      case 'NOPOSITION_BLOCKED':
        // Check if 1-minute lock expired
        if (state.lastBlockedAtMs && this.isFirstSecondNextMinute(state.lastBlockedAtMs, now)) {
          console.log(`[TradingEngine] 🔓 SHORT UNBLOCKED after 1 minute`);
          // Re-check entry condition
          if (ltp < state.threshold) {
            console.log(`[TradingEngine] 📉 SHORT RE-ENTRY: LTP ${ltp} < threshold ${state.threshold}`);
            state.fsmState = 'SELLPOSITION';
            this.openPaperTrade('SHORT', state, symbol, ltp);
          } else {
            // Stay blocked, reset timer
            state.lastBlockedAtMs = now;
          }
        }
        break;
    }
    
    // Update FSM display
    this.fsmBySymbol.set(symbol + '_SHORT', {
      state: state.fsmState,
      threshold: state.threshold
    });
  }

  // --- WEBHOOK SIGNAL PROCESSING ---
  
  processWebhookSignal(signal) {
    const { symbol, intent, stoppx, side } = signal;
    if (!symbol) return;
    
    const normalizedSymbol = symbol.toUpperCase();
    
    // Only process BTC signals - ignore all others (options, stocks, etc.)
    if (!normalizedSymbol.includes('BTC')) {
      console.log(`[TradingEngine] ⏭️ Ignoring non-BTC signal: ${normalizedSymbol}`);
      return;
    }
    
    const ltp = this.ltpBySymbol.get(normalizedSymbol);
    const now = Date.now();
    
    // Determine direction from side (priority) or intent (fallback)
    // Side takes precedence: BUY side = LONG, SELL side = SHORT
    const isBuy = side === 'BUY' || (side !== 'SELL' && intent === 'ENTRY');
    const isSell = side === 'SELL' || (side !== 'BUY' && intent === 'EXIT');
    
    const signalRecord = {
      timeIst: this.formatIstTime(new Date()),
      intent: isBuy ? 'BUY' : 'SELL',
      stoppx,
      ltp: ltp || null,
      receivedAt: now
    };
    
    if (isBuy) {
      // BUY signal → Set threshold and wait for breakout
      this.longState.signals.unshift(signalRecord);
      this.longState.signals = this.longState.signals.slice(0, 50);
      
      // Set threshold from stoppx (or LTP if no stoppx)
      this.longState.threshold = stoppx || ltp;
      this.longState.lastSignalAtMs = now;
      
      if (this.longState.fsmState === 'NOPOSITION' || this.longState.fsmState === 'NOPOSITION_BLOCKED') {
        this.longState.fsmState = 'NOPOSITION_SIGNAL';
        console.log(`[TradingEngine] 📶 LONG Signal received: threshold=${this.longState.threshold}, waiting for LTP > threshold`);
      } else if (this.longState.fsmState === 'BUYPOSITION') {
        // Already in position, update threshold (trailing stop)
        console.log(`[TradingEngine] 📶 LONG already in position, updating threshold to ${this.longState.threshold}`);
      }
      
    } else if (isSell) {
      // SELL signal → Set threshold and wait for breakdown
      this.shortState.signals.unshift(signalRecord);
      this.shortState.signals = this.shortState.signals.slice(0, 50);
      
      // For SELL: Always use current LTP as threshold (ignore stoppx)
      this.shortState.threshold = ltp;
      this.shortState.lastSignalAtMs = now;
      
      if (this.shortState.fsmState === 'NOPOSITION' || this.shortState.fsmState === 'NOPOSITION_BLOCKED') {
        this.shortState.fsmState = 'NOPOSITION_SIGNAL';
        console.log(`[TradingEngine] 📶 SHORT Signal received: threshold=${this.shortState.threshold} (LTP), waiting for LTP < threshold`);
      } else if (this.shortState.fsmState === 'SELLPOSITION') {
        // Already in position, update threshold (trailing stop)
        console.log(`[TradingEngine] 📶 SHORT already in position, updating threshold to ${this.shortState.threshold}`);
      }
    }
    
    this.broadcastState();
  }

  openPaperTrade(direction, state, symbol, entryPrice) {
    if (state.paperTrade) {
      console.log(`[TradingEngine] ${direction} paper trade already open, skipping`);
      return;
    }
    
    const trade = {
      id: `paper-${direction}-${symbol}-${Date.now()}`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      direction,
      entryPrice,
      currentPrice: entryPrice,
      quantity: POSITION_SIZE / entryPrice,  // Calculate quantity from $1000 position size
      unrealizedPnl: 0,
      enteredAt: Date.now()
    };
    
    state.paperTrade = trade;
    
    // Set pending for live trade activation
    state.liveState.pendingPaperTrade = {
      entryPrice,
      quantity: trade.quantity,
      lot: 1,
      openedAt: Date.now()
    };
    
    console.log(`[TradingEngine] 📈 ${direction} Paper ENTRY: ${symbol} @ ${entryPrice}`);
  }

  closePaperTrade(direction, state, exitPrice, reason) {
    if (!state.paperTrade) return;
    
    const trade = state.paperTrade;
    let realizedPnl;
    
    if (direction === 'LONG') {
      realizedPnl = (exitPrice - trade.entryPrice) * trade.quantity;
    } else {
      realizedPnl = (trade.entryPrice - exitPrice) * trade.quantity;
    }
    
    state.liveState.cumulativePnl += realizedPnl;
    
    console.log(`[TradingEngine] 📉 ${direction} Paper EXIT (${reason}): ${trade.symbol} @ ${exitPrice}, PnL: $${realizedPnl.toFixed(2)}`);
    
    // Save to paper trade history
    state.paperTrades.unshift({
      ...trade,
      exitPrice,
      exitTimeIst: this.formatIstTime(new Date()),
      realizedPnl,
      reason,
      closedAt: Date.now()
    });
    
    // Save final peak to history (if there was one)
    if (state.currentPeakPnl !== null && state.currentPeakPnl > 0) {
      state.peakPnlHistory.unshift({
        pnl: state.currentPeakPnl,
        timeIst: this.formatIstTime(new Date()),
        timestamp: Date.now()
      });
    }
    
    // Close live trade if open
    if (state.liveState.openTrade) {
      this.closeLiveTrade(direction, state, exitPrice, reason);
    }
    
    state.paperTrade = null;
    state.liveState.pendingPaperTrade = null;
    state.currentPeakPnl = null;  // Reset peak for next trade
    
    // Save state immediately after trade closes
    this.saveState();
  }

  // --- LIVE TRADE MANAGEMENT ---
  
  checkLiveTrade(direction, state, totalPnl, currentPrice, symbol) {
    const liveState = state.liveState;
    
    // Check if block expired (1-minute lock)
    if (liveState.blockedAtMs && this.isFirstSecondNextMinute(liveState.blockedAtMs, Date.now())) {
      liveState.blockedAtMs = null;
      console.log(`[TradingEngine] 🔓 ${direction} Live Block expired`);
    }
    
    // Protective close: when PnL drops to <= 0
    if (liveState.state === 'POSITION' && liveState.openTrade && totalPnl <= CLOSE_THRESHOLD) {
      console.log(`[TradingEngine] 🛡️ ${direction} Protective close: PnL ${totalPnl.toFixed(2)} <= ${CLOSE_THRESHOLD}`);
      this.closeLiveTrade(direction, state, currentPrice, 'Protective');
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

  openLiveTrade(direction, state, entryPrice, symbol) {
    const liveState = state.liveState;
    const pending = liveState.pendingPaperTrade;
    if (!pending) return;
    
    const id = `live-${direction}-${symbol}-${Date.now()}`;
    const timeIst = this.formatIstTime(new Date());
    
    liveState.openTrade = {
      id,
      symbol,
      entryPrice,
      quantity: pending.quantity,
      lot: pending.lot,
      timeIst
    };
    liveState.state = 'POSITION';
    
    const tradeRow = {
      id,
      timeIst,
      symbol,
      action: 'ENTRY',
      entryPrice,
      exitPrice: null,
      quantity: pending.quantity,
      realizedPnl: null,
      cumulativePnl: liveState.cumulativePnl
    };
    
    liveState.trades = [tradeRow, ...liveState.trades].slice(0, 50);
    
    console.log(`[TradingEngine] ✅ ${direction} LIVE TRADE OPENED: ${symbol} @ ${entryPrice}`);
    this.sendLiveSignal('ENTRY', symbol, entryPrice, direction);
  }

  closeLiveTrade(direction, state, exitPrice, reason) {
    const liveState = state.liveState;
    if (!liveState.openTrade) return;
    
    const openTrade = liveState.openTrade;
    let realizedPnl;
    
    if (direction === 'LONG') {
      realizedPnl = (exitPrice - openTrade.entryPrice) * openTrade.quantity * openTrade.lot;
    } else {
      realizedPnl = (openTrade.entryPrice - exitPrice) * openTrade.quantity * openTrade.lot;
    }
    
    liveState.cumulativePnl += realizedPnl;
    
    const exitRow = {
      id: `${openTrade.id}-exit`,
      timeIst: this.formatIstTime(new Date()),
      closedAt: Date.now(),  // Timestamp for filtering by reset
      symbol: openTrade.symbol,
      action: 'EXIT',
      entryPrice: openTrade.entryPrice,
      exitPrice,
      quantity: openTrade.quantity,
      realizedPnl,
      cumulativePnl: liveState.cumulativePnl
    };
    
    liveState.trades = [exitRow, ...liveState.trades].slice(0, 50);
    liveState.openTrade = null;
    liveState.state = 'NO_POSITION';
    liveState.unrealizedPnl = 0;
    
    console.log(`[TradingEngine] ✅ ${direction} LIVE TRADE CLOSED (${reason}): ${openTrade.symbol} @ ${exitPrice}, PnL: $${realizedPnl.toFixed(2)}`);
    this.sendLiveSignal('EXIT', openTrade.symbol, exitPrice, direction);
  }

  async sendLiveSignal(kind, symbol, refPrice, direction) {
    try {
      // Map symbol if needed
      let deltaSymbol = symbol;
      if (symbol === 'BTCUSDT') {
        deltaSymbol = 'BTCUSD';
      }
      
      // Route based on direction
      if (direction === 'SHORT') {
        // SHORT trades → Direct Delta API call
        await this.sendShortToDelta(kind, deltaSymbol, refPrice);
      } else {
        // LONG trades → Firebase cloud function (Bharath's)
        await this.sendLongToFirebase(kind, deltaSymbol, refPrice);
      }
    } catch (err) {
      console.error(`[TradingEngine] ❌ Failed to send live signal:`, err.message);
    }
  }

  async sendLongToFirebase(kind, symbol, refPrice) {
    const message = kind === 'ENTRY'
      ? `Accepted Entry + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`
      : `Accepted Exit + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`;
    
    console.log(`[TradingEngine] 🚀 Sending LONG ${kind} to Firebase: ${symbol} @ ${refPrice}`);
    
    const response = await fetch(LIVE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    
    const result = await response.text();
    console.log(`[TradingEngine] ✅ Firebase response:`, result);
  }

  async sendShortToDelta(kind, symbol, refPrice) {
    const deltaApi = require('./delta-api');
    const sizeUsd = POSITION_SIZE;  // Use same position size as paper trading
    
    console.log(`[TradingEngine] 🚀 Sending SHORT ${kind} to Delta API: ${symbol} @ ${refPrice}, size: $${sizeUsd}`);
    
    try {
      if (kind === 'ENTRY') {
        const result = await deltaApi.openShortPosition(symbol, sizeUsd);
        console.log(`[TradingEngine] ✅ Delta SHORT ENTRY placed:`, result);
      } else {
        const result = await deltaApi.closeShortPosition(symbol, sizeUsd);
        console.log(`[TradingEngine] ✅ Delta SHORT EXIT placed:`, result);
      }
    } catch (err) {
      console.error(`[TradingEngine] ❌ Delta API error:`, err.message);
    }
  }

  // --- UTILITY FUNCTIONS ---
  
  isFirstSecondNextMinute(anchorAtMs, tickAtMs) {
    return Math.floor(tickAtMs / 60000) > Math.floor(anchorAtMs / 60000);
  }

  formatIstTime(date) {
    // Use en-GB to avoid 24:xx issue with en-IN
    return date.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
  }

  // --- STATE PERSISTENCE ---
  
  saveState() {
    try {
      const state = {
        savedAt: Date.now(),
        lastResetDate: this.lastResetDate,
        lastResetTimestamp: this.lastResetTimestamp,
        long: {
          fsmState: this.longState.fsmState,
          threshold: this.longState.threshold,
          paperTrades: this.longState.paperTrades,
          peakPnlHistory: this.longState.peakPnlHistory,
          currentPeakPnl: this.longState.currentPeakPnl,
          signals: this.longState.signals,
          liveStateTrades: this.longState.liveState.trades,
          liveStateCumulativePnl: this.longState.liveState.cumulativePnl
        },
        short: {
          fsmState: this.shortState.fsmState,
          threshold: this.shortState.threshold,
          paperTrades: this.shortState.paperTrades,
          peakPnlHistory: this.shortState.peakPnlHistory,
          currentPeakPnl: this.shortState.currentPeakPnl,
          signals: this.shortState.signals,
          liveStateTrades: this.shortState.liveState.trades,
          liveStateCumulativePnl: this.shortState.liveState.cumulativePnl
        }
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      // Silent save - only log errors
    } catch (err) {
      console.error('[TradingEngine] ❌ Failed to save state:', err.message);
    }
  }

  loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        console.log('[TradingEngine] No saved state found, starting fresh');
        return;
      }
      
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      
      // Restore shared state
      this.lastResetDate = state.lastResetDate;
      this.lastResetTimestamp = state.lastResetTimestamp || Date.now();
      
      // Restore LONG state
      if (state.long) {
        this.longState.fsmState = state.long.fsmState || 'NOPOSITION';
        this.longState.threshold = state.long.threshold;
        this.longState.paperTrades = state.long.paperTrades || [];
        this.longState.peakPnlHistory = state.long.peakPnlHistory || [];
        this.longState.currentPeakPnl = state.long.currentPeakPnl;
        this.longState.signals = state.long.signals || [];
        this.longState.liveState.trades = state.long.liveStateTrades || [];
        this.longState.liveState.cumulativePnl = state.long.liveStateCumulativePnl || 0;
      }
      
      // Restore SHORT state
      if (state.short) {
        this.shortState.fsmState = state.short.fsmState || 'NOPOSITION';
        this.shortState.threshold = state.short.threshold;
        this.shortState.paperTrades = state.short.paperTrades || [];
        this.shortState.peakPnlHistory = state.short.peakPnlHistory || [];
        this.shortState.currentPeakPnl = state.short.currentPeakPnl;
        this.shortState.signals = state.short.signals || [];
        this.shortState.liveState.trades = state.short.liveStateTrades || [];
        this.shortState.liveState.cumulativePnl = state.short.liveStateCumulativePnl || 0;
      }
      
      const savedAgo = Math.round((Date.now() - state.savedAt) / 1000);
      console.log(`[TradingEngine] ✅ State restored from ${STATE_FILE} (saved ${savedAgo}s ago)`);
    } catch (err) {
      console.error('[TradingEngine] ❌ Failed to load state:', err.message);
    }
  }
}

module.exports = { TradingEngine };
