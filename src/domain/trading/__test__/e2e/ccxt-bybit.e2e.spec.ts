/**
 * CcxtBroker e2e — real orders against Bybit demo/sandbox.
 *
 * Reads Alice's config, picks the first CCXT Bybit account on a
 * sandbox/demoTrading platform. If none configured, entire suite skips.
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { getTestAccounts, filterByProvider } from './setup.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

let broker: IBroker | null = null

beforeAll(async () => {
  const all = await getTestAccounts()
  const bybit = filterByProvider(all, 'ccxt').find(a => a.id.includes('bybit'))
  if (!bybit) {
    console.log('e2e: No Bybit sandbox/demo account configured, skipping')
    return
  }
  broker = bybit.broker
  console.log(`e2e: ${bybit.label} connected`)
}, 60_000)

describe('CcxtBroker — Bybit e2e', () => {
  it('has a configured Bybit account (or skips entire suite)', () => {
    if (!broker) {
      console.log('e2e: skipped — no Bybit account')
      return
    }
    expect(broker).toBeDefined()
  })

  it('fetches account info with positive equity', async () => {
    if (!broker) return
    const account = await broker.getAccount()
    expect(account.netLiquidation).toBeGreaterThan(0)
    console.log(`  equity: $${account.netLiquidation.toFixed(2)}, cash: $${account.totalCashValue.toFixed(2)}`)
  })

  it('fetches positions', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    expect(Array.isArray(positions)).toBe(true)
    console.log(`  ${positions.length} open positions`)
  })

  it('searches ETH contracts', async () => {
    if (!broker) return
    const results = await broker.searchContracts('ETH')
    expect(results.length).toBeGreaterThan(0)
    const perp = results.find(r => r.contract.localSymbol?.includes('USDT:USDT'))
    expect(perp).toBeDefined()
    console.log(`  found ${results.length} ETH contracts, perp: ${perp!.contract.localSymbol}`)
  })

  it('places market buy 0.01 ETH → execution returned', async () => {
    if (!broker) return

    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.localSymbol?.includes('USDT:USDT'))
    if (!ethPerp) { console.log('  no ETH/USDT perp, skipping'); return }

    // Diagnostic: see raw CCXT createOrder response
    const exchange = (broker as any).exchange
    const rawOrder = await exchange.createOrder('ETH/USDT:USDT', 'market', 'buy', 0.01)
    console.log('  CCXT raw createOrder:', JSON.stringify({
      id: rawOrder.id, status: rawOrder.status, filled: rawOrder.filled,
      average: rawOrder.average, amount: rawOrder.amount, remaining: rawOrder.remaining,
      datetime: rawOrder.datetime, type: rawOrder.type, side: rawOrder.side,
    }))

    // Clean up diagnostic order
    await broker.closePosition(ethPerp.contract, new Decimal('0.01'))

    // Now test through our placeOrder
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const result = await broker.placeOrder(ethPerp.contract, order)
    expect(result.success).toBe(true)
    expect(result.orderId).toBeDefined()
    console.log(`  placeOrder result: orderId=${result.orderId}, execution=${!!result.execution}, orderState=${result.orderState?.status}`)

    if (result.execution) {
      expect(result.execution.shares.toNumber()).toBeGreaterThan(0)
      expect(result.execution.price).toBeGreaterThan(0)
      console.log(`  filled: ${result.execution.shares} @ $${result.execution.price}`)
    }
  }, 30_000)

  it('verifies ETH position exists after buy', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    const ethPos = positions.find(p => p.contract.symbol === 'ETH')
    expect(ethPos).toBeDefined()
    console.log(`  ETH position: ${ethPos!.quantity} ${ethPos!.side}`)
  })

  it('closes ETH position with reduceOnly', async () => {
    if (!broker) return

    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.localSymbol?.includes('USDT:USDT'))
    if (!ethPerp) return

    const result = await broker.closePosition(ethPerp.contract, new Decimal('0.01'))
    expect(result.success).toBe(true)
    console.log(`  close orderId=${result.orderId}, success=${result.success}`)
  }, 15_000)

  it('queries order by ID', async () => {
    if (!broker) return

    // Place a small order to get an orderId
    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.localSymbol?.includes('USDT:USDT'))
    if (!ethPerp) return

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const placed = await broker.placeOrder(ethPerp.contract, order)
    if (!placed.orderId) return

    // Wait for exchange to settle — Bybit needs time before order appears in closed list
    await new Promise(r => setTimeout(r, 5000))

    const detail = await broker.getOrder(placed.orderId)
    console.log(`  getOrder(${placed.orderId}): ${detail ? `status=${detail.orderState.status}` : 'null'}`)

    expect(detail).not.toBeNull()
    if (detail) {
      expect(detail.orderState.status).toBe('Filled')
    }

    // Clean up
    await broker.closePosition(ethPerp.contract, new Decimal('0.01'))
  }, 15_000)
})
