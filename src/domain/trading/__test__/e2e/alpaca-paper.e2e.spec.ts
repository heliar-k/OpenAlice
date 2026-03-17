/**
 * AlpacaBroker e2e — real orders against Alpaca paper trading.
 *
 * Reads Alice's config, picks the first Alpaca paper account.
 * If none configured, entire suite skips.
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { getTestAccounts, filterByProvider } from './setup.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

let broker: IBroker | null = null

beforeAll(async () => {
  const all = await getTestAccounts()
  const alpaca = filterByProvider(all, 'alpaca')[0]
  if (!alpaca) {
    console.log('e2e: No Alpaca paper account configured, skipping')
    return
  }
  broker = alpaca.broker
  console.log(`e2e: ${alpaca.label} connected`)
}, 60_000)

describe('AlpacaBroker — Paper e2e', () => {
  it('has a configured Alpaca paper account (or skips entire suite)', () => {
    if (!broker) {
      console.log('e2e: skipped — no Alpaca paper account')
      return
    }
    expect(broker).toBeDefined()
  })

  it('fetches account info with positive equity', async () => {
    if (!broker) return
    const account = await broker.getAccount()
    expect(account.netLiquidation).toBeGreaterThan(0)
    expect(account.totalCashValue).toBeGreaterThan(0)
    console.log(`  equity: $${account.netLiquidation.toFixed(2)}, cash: $${account.totalCashValue.toFixed(2)}, buying_power: $${account.buyingPower?.toFixed(2)}`)
    console.log(`  unrealizedPnL: $${account.unrealizedPnL}, realizedPnL: $${account.realizedPnL}, dayTrades: ${account.dayTradesRemaining}`)
  })

  it('fetches market clock', async () => {
    if (!broker) return
    const clock = await broker.getMarketClock()
    expect(typeof clock.isOpen).toBe('boolean')
    console.log(`  isOpen: ${clock.isOpen}, nextOpen: ${clock.nextOpen?.toISOString()}, nextClose: ${clock.nextClose?.toISOString()}`)
  })

  it('searches AAPL contracts', async () => {
    if (!broker) return
    const results = await broker.searchContracts('AAPL')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].contract.symbol).toBe('AAPL')
    // Broker no longer sets aliceId — that's UTA's job
    expect(results[0].contract.aliceId).toBeUndefined()
    console.log(`  found: ${results[0].contract.symbol}, secType: ${results[0].contract.secType}`)
  })

  it('fetches AAPL quote with valid prices', async () => {
    if (!broker) return
    const contract = new Contract()
    contract.aliceId = 'alpaca-AAPL'
    contract.symbol = 'AAPL'

    const quote = await broker.getQuote(contract)
    expect(quote.last).toBeGreaterThan(0)
    expect(quote.bid).toBeGreaterThan(0)
    expect(quote.ask).toBeGreaterThan(0)
    expect(quote.volume).toBeGreaterThan(0)
    console.log(`  AAPL: last=$${quote.last}, bid=$${quote.bid}, ask=$${quote.ask}, vol=${quote.volume}`)
  })

  it('places market buy 1 AAPL → success with UUID orderId', async () => {
    if (!broker) return

    const contract = new Contract()
    contract.aliceId = 'alpaca-AAPL'
    contract.symbol = 'AAPL'
    contract.secType = 'STK'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('1')
    order.tif = 'DAY'

    const result = await broker.placeOrder(contract, order)
    console.log(`  placeOrder raw:`, JSON.stringify({
      success: result.success,
      orderId: result.orderId,
      orderState: result.orderState?.status,
      error: result.error,
    }))

    expect(result.success).toBe(true)
    expect(result.orderId).toBeDefined()
    // Alpaca order IDs are UUIDs like "b0b6dd9d-8b9b-..."
    expect(result.orderId!.length).toBeGreaterThan(10)
    console.log(`  orderId: ${result.orderId} (length=${result.orderId!.length})`)
  }, 15_000)

  it('queries order by ID after place', async () => {
    if (!broker) return

    // Place a fresh order to get an ID
    const contract = new Contract()
    contract.aliceId = 'alpaca-AAPL'
    contract.symbol = 'AAPL'
    contract.secType = 'STK'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('1')
    order.tif = 'DAY'

    const placed = await broker.placeOrder(contract, order)
    if (!placed.orderId) { console.log('  no orderId returned, skipping'); return }

    // Wait for fill
    await new Promise(r => setTimeout(r, 2000))

    const detail = await broker.getOrder(placed.orderId)
    console.log(`  getOrder(${placed.orderId}):`, detail ? JSON.stringify({
      symbol: detail.contract.symbol,
      action: detail.order.action,
      qty: detail.order.totalQuantity.toString(),
      status: detail.orderState.status,
      orderId_number: detail.order.orderId,
    }) : 'null')

    expect(detail).not.toBeNull()
    if (detail) {
      expect(detail.orderState.status).toBe('Filled')
      // Bug check: order.orderId should NOT be NaN or meaningless
      console.log(`  order.orderId (IBKR number field): ${detail.order.orderId} — parseInt('${placed.orderId}') = ${parseInt(placed.orderId, 10)}`)
    }
  }, 15_000)

  it('verifies AAPL position exists after buy', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    const aapl = positions.find(p => p.contract.symbol === 'AAPL')
    expect(aapl).toBeDefined()
    if (aapl) {
      console.log(`  AAPL position: ${aapl.quantity} ${aapl.side}, avg=$${aapl.avgCost}, mkt=$${aapl.marketPrice}, unrealPnL=$${aapl.unrealizedPnL}`)
      expect(aapl.quantity.toNumber()).toBeGreaterThan(0)
      expect(aapl.avgCost).toBeGreaterThan(0)
      expect(aapl.marketPrice).toBeGreaterThan(0)
    }
  })

  it('closes AAPL position', async () => {
    if (!broker) return

    const contract = new Contract()
    contract.aliceId = 'alpaca-AAPL'
    contract.symbol = 'AAPL'

    // Close all AAPL — use native full close
    const result = await broker.closePosition(contract)
    console.log(`  closePosition: success=${result.success}, orderId=${result.orderId}, error=${result.error}`)
    expect(result.success).toBe(true)
  }, 15_000)

  it('getOrders with known IDs', async () => {
    if (!broker) return

    // Place + wait + query
    const contract = new Contract()
    contract.aliceId = 'alpaca-AAPL'
    contract.symbol = 'AAPL'
    contract.secType = 'STK'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('1')
    order.tif = 'DAY'

    const placed = await broker.placeOrder(contract, order)
    if (!placed.orderId) return

    await new Promise(r => setTimeout(r, 2000))

    const orders = await broker.getOrders([placed.orderId])
    console.log(`  getOrders([${placed.orderId}]): ${orders.length} results`)
    expect(orders.length).toBe(1)
    if (orders[0]) {
      console.log(`  order: ${orders[0].contract.symbol} ${orders[0].order.action} ${orders[0].orderState.status}`)
    }

    // Clean up
    await broker.closePosition(contract)
  }, 15_000)

  it('fetches positions with correct types', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    console.log(`  ${positions.length} positions total`)
    for (const p of positions) {
      console.log(`  ${p.contract.symbol}: qty=${p.quantity} (type=${typeof p.quantity.toNumber()}), avg=${p.avgCost} (type=${typeof p.avgCost}), mkt=${p.marketPrice}`)
      // Verify quantity is actually a Decimal
      expect(p.quantity).toBeInstanceOf(Decimal)
      expect(typeof p.avgCost).toBe('number')
      expect(typeof p.marketPrice).toBe('number')
      expect(typeof p.unrealizedPnL).toBe('number')
    }
  })
})
