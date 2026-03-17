/**
 * UnifiedTradingAccount (UTA) — the business entity for trading.
 *
 * Owns: broker connection (IBroker), operation history (TradingGit), and strategy guards.
 * AI and frontend interact with this class, never with IBroker directly.
 *
 * Analogous to a git repository: each UTA maintains its own commit history.
 */

import Decimal from 'decimal.js'
import { Contract, Order, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type { IBroker, AccountInfo, Position, OpenOrder, PlaceOrderResult, Quote, MarketClock, AccountCapabilities } from './brokers/types.js'
import { TradingGit } from './git/TradingGit.js'
import type {
  Operation,
  AddResult,
  CommitPrepareResult,
  PushResult,
  GitStatus,
  GitCommit,
  GitState,
  GitExportState,
  CommitLogEntry,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
} from './git/types.js'
import { createGuardPipeline, resolveGuards } from './guards/index.js'
import './contract-ext.js'

// ==================== IBKR field mapping ====================

/** Map human-readable order type → IBKR short code. */
function toIbkrOrderType(type: string): string {
  switch (type) {
    case 'market': return 'MKT'
    case 'limit': return 'LMT'
    case 'stop': return 'STP'
    case 'stop_limit': return 'STP LMT'
    case 'trailing_stop': return 'TRAIL'
    case 'trailing_stop_limit': return 'TRAIL LIMIT'
    case 'moc': return 'MOC'
    default: return type.toUpperCase()
  }
}

/** Map human-readable TIF → IBKR short code. */
function toIbkrTif(tif: string): string {
  return tif.toUpperCase()
}

// ==================== Options ====================

export interface UnifiedTradingAccountOptions {
  guards?: Array<{ type: string; options?: Record<string, unknown> }>
  savedState?: GitExportState
  onCommit?: (state: GitExportState) => void | Promise<void>
  platformId?: string
}

// ==================== Stage param types ====================

export interface StagePlaceOrderParams {
  aliceId: string
  symbol?: string
  side: 'buy' | 'sell'
  type: string
  qty?: number
  notional?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  timeInForce?: string
  goodTillDate?: string
  extendedHours?: boolean
  parentId?: string
  ocaGroup?: string
}

export interface StageModifyOrderParams {
  orderId: string
  qty?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  type?: string
  timeInForce?: string
  goodTillDate?: string
}

export interface StageClosePositionParams {
  aliceId: string
  symbol?: string
  qty?: number
}

// ==================== UnifiedTradingAccount ====================

export class UnifiedTradingAccount {
  readonly id: string
  readonly label: string
  readonly broker: IBroker
  readonly git: TradingGit
  readonly platformId?: string

  private readonly _getState: () => Promise<GitState>

  constructor(broker: IBroker, options: UnifiedTradingAccountOptions = {}) {
    this.broker = broker
    this.id = broker.id
    this.label = broker.label
    this.platformId = options.platformId

    // Wire internals
    this._getState = async (): Promise<GitState> => {
      const pendingIds = this.git.getPendingOrderIds().map(p => p.orderId)
      const [accountInfo, positions, orders] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        broker.getOrders(pendingIds),
      ])
      // Stamp aliceId on all contracts returned by broker
      for (const p of positions) this.stampAliceId(p.contract)
      for (const o of orders) this.stampAliceId(o.contract)
      return {
        netLiquidation: accountInfo.netLiquidation,
        totalCashValue: accountInfo.totalCashValue,
        unrealizedPnL: accountInfo.unrealizedPnL,
        realizedPnL: accountInfo.realizedPnL,
        positions,
        pendingOrders: orders.filter(o => o.orderState.status === 'Submitted' || o.orderState.status === 'PreSubmitted'),
      }
    }

    const dispatcher = async (op: Operation): Promise<unknown> => {
      switch (op.action) {
        case 'placeOrder':
          return broker.placeOrder(op.contract, op.order)
        case 'modifyOrder':
          return broker.modifyOrder(op.orderId, op.changes as Parameters<IBroker['modifyOrder']>[1])
        case 'closePosition':
          return broker.closePosition(op.contract, op.quantity)
        case 'cancelOrder':
          return broker.cancelOrder(op.orderId, op.orderCancel)
        default:
          throw new Error(`Unknown operation action: ${(op as { action: string }).action}`)
      }
    }
    const guards = resolveGuards(options.guards ?? [])
    const guardedDispatcher = createGuardPipeline(dispatcher, broker, guards)

    const gitConfig = {
      executeOperation: guardedDispatcher,
      getGitState: this._getState,
      onCommit: options.onCommit,
    }

    this.git = options.savedState
      ? TradingGit.restore(options.savedState, gitConfig)
      : new TradingGit(gitConfig)
  }

  // ==================== aliceId management ====================

  /** Construct aliceId: "{utaId}|{nativeKey}" */
  private stampAliceId(contract: Contract): void {
    const nativeKey = contract.localSymbol || contract.symbol || ''
    contract.aliceId = `${this.id}|${nativeKey}`
  }

  /** Parse aliceId → { utaId, nativeKey }, or null if invalid. */
  static parseAliceId(aliceId: string): { utaId: string; nativeKey: string } | null {
    const sep = aliceId.indexOf('|')
    if (sep === -1) return null
    return { utaId: aliceId.slice(0, sep), nativeKey: aliceId.slice(sep + 1) }
  }

  // ==================== Stage operations ====================

  stagePlaceOrder(params: StagePlaceOrderParams): AddResult {
    const contract = new Contract()
    contract.aliceId = params.aliceId
    // Extract nativeKey from aliceId for broker resolution
    const parsed = UnifiedTradingAccount.parseAliceId(params.aliceId)
    if (parsed) {
      contract.symbol = parsed.nativeKey
      contract.localSymbol = parsed.nativeKey
    }
    if (params.symbol) contract.symbol = params.symbol

    const order = new Order()
    order.action = params.side === 'buy' ? 'BUY' : 'SELL'
    order.orderType = toIbkrOrderType(params.type)
    order.tif = toIbkrTif(params.timeInForce ?? 'day')

    if (params.qty != null) order.totalQuantity = new Decimal(String(params.qty))
    if (params.notional != null) order.cashQty = params.notional
    if (params.price != null) order.lmtPrice = params.price
    if (params.stopPrice != null) order.auxPrice = params.stopPrice
    if (params.trailingAmount != null) order.auxPrice = params.trailingAmount
    if (params.trailingPercent != null) order.trailingPercent = params.trailingPercent
    if (params.goodTillDate != null) order.goodTillDate = params.goodTillDate
    if (params.extendedHours) order.outsideRth = true
    if (params.parentId != null) order.parentId = parseInt(params.parentId, 10) || 0
    if (params.ocaGroup != null) order.ocaGroup = params.ocaGroup

    return this.git.add({ action: 'placeOrder', contract, order })
  }

  stageModifyOrder(params: StageModifyOrderParams): AddResult {
    const changes: Partial<Order> = {}
    if (params.qty != null) changes.totalQuantity = new Decimal(String(params.qty))
    if (params.price != null) changes.lmtPrice = params.price
    if (params.stopPrice != null) changes.auxPrice = params.stopPrice
    if (params.trailingAmount != null) changes.auxPrice = params.trailingAmount
    if (params.trailingPercent != null) changes.trailingPercent = params.trailingPercent
    if (params.type != null) changes.orderType = toIbkrOrderType(params.type)
    if (params.timeInForce != null) changes.tif = toIbkrTif(params.timeInForce)
    if (params.goodTillDate != null) changes.goodTillDate = params.goodTillDate

    return this.git.add({ action: 'modifyOrder', orderId: params.orderId, changes })
  }

  stageClosePosition(params: StageClosePositionParams): AddResult {
    const contract = new Contract()
    contract.aliceId = params.aliceId
    const parsed = UnifiedTradingAccount.parseAliceId(params.aliceId)
    if (parsed) {
      contract.symbol = parsed.nativeKey
      contract.localSymbol = parsed.nativeKey
    }
    if (params.symbol) contract.symbol = params.symbol

    return this.git.add({
      action: 'closePosition',
      contract,
      quantity: params.qty != null ? new Decimal(String(params.qty)) : undefined,
    })
  }

  stageCancelOrder(params: { orderId: string }): AddResult {
    return this.git.add({ action: 'cancelOrder', orderId: params.orderId })
  }

  // ==================== Git flow ====================

  commit(message: string): CommitPrepareResult {
    return this.git.commit(message)
  }

  push(): Promise<PushResult> {
    return this.git.push()
  }

  // ==================== Git queries ====================

  log(options?: { limit?: number; symbol?: string }): CommitLogEntry[] {
    return this.git.log(options)
  }

  show(hash: string): GitCommit | null {
    return this.git.show(hash)
  }

  status(): GitStatus {
    return this.git.status()
  }

  async sync(opts?: { delayMs?: number }): Promise<SyncResult> {
    const pendingOrders = this.git.getPendingOrderIds()
    if (pendingOrders.length === 0) {
      return { hash: '', updatedCount: 0, updates: [] }
    }

    // Optional delay — gives exchange APIs time to settle before querying
    if (opts?.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))

    const updates: OrderStatusUpdate[] = []

    for (const { orderId, symbol } of pendingOrders) {
      const brokerOrder = await this.broker.getOrder(orderId)
      if (!brokerOrder) continue

      const status = brokerOrder.orderState.status
      if (status !== 'Submitted' && status !== 'PreSubmitted') {
        updates.push({
          orderId,
          symbol,
          previousStatus: 'submitted',
          currentStatus: status === 'Filled' ? 'filled' : status === 'Cancelled' ? 'cancelled' : 'rejected',
        })
      }
    }

    if (updates.length === 0) {
      return { hash: '', updatedCount: 0, updates: [] }
    }

    const state = await this._getState()
    return this.git.sync(updates, state)
  }

  getPendingOrderIds(): Array<{ orderId: string; symbol: string }> {
    return this.git.getPendingOrderIds()
  }

  simulatePriceChange(priceChanges: PriceChangeInput[]): Promise<SimulatePriceChangeResult> {
    return this.git.simulatePriceChange(priceChanges)
  }

  setCurrentRound(round: number): void {
    this.git.setCurrentRound(round)
  }

  // ==================== Broker queries (delegation) ====================

  getAccount(): Promise<AccountInfo> {
    return this.broker.getAccount()
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.broker.getPositions()
    for (const p of positions) this.stampAliceId(p.contract)
    return positions
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const orders = await this.broker.getOrders(orderIds)
    for (const o of orders) this.stampAliceId(o.contract)
    return orders
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const quote = await this.broker.getQuote(contract)
    this.stampAliceId(quote.contract)
    return quote
  }

  getMarketClock(): Promise<MarketClock> {
    return this.broker.getMarketClock()
  }

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    const results = await this.broker.searchContracts(pattern)
    for (const desc of results) this.stampAliceId(desc.contract)
    return results
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const details = await this.broker.getContractDetails(query)
    if (details) this.stampAliceId(details.contract)
    return details
  }

  getCapabilities(): AccountCapabilities {
    return this.broker.getCapabilities()
  }

  // ==================== State ====================

  getState(): Promise<GitState> {
    return this._getState()
  }

  exportGitState(): GitExportState {
    return this.git.exportState()
  }

  // ==================== Lifecycle ====================

  init(): Promise<void> {
    return this.broker.init()
  }

  close(): Promise<void> {
    return this.broker.close()
  }
}
