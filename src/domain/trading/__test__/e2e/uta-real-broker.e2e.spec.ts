/**
 * UTA e2e — full Trading-as-Git lifecycle against real brokers.
 *
 * Tests the complete flow: stage → commit → push → sync → verify
 * against Alpaca paper (US equities) and Bybit demo (crypto perps).
 *
 * Each platform is a single sequential test to avoid cascading failures.
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { getTestAccounts, filterByProvider } from './setup.js'
import { UnifiedTradingAccount } from '../../UnifiedTradingAccount.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

// ==================== Alpaca — AAPL lifecycle ====================

describe('UTA — Alpaca paper (AAPL)', () => {
  let broker: IBroker | null = null

  beforeAll(async () => {
    const all = await getTestAccounts()
    const alpaca = filterByProvider(all, 'alpaca')[0]
    if (!alpaca) {
      console.log('e2e: No Alpaca paper account, skipping UTA Alpaca tests')
      return
    }
    broker = alpaca.broker
  }, 60_000)

  it('full lifecycle: buy → sync → verify → close → sync → verify', async () => {
    if (!broker) { console.log('e2e: skipped — no Alpaca paper account'); return }

    const uta = new UnifiedTradingAccount(broker)

    // Record initial state
    const initialPositions = await broker.getPositions()
    const initialAaplQty = initialPositions.find(p => p.contract.symbol === 'AAPL')?.quantity.toNumber() ?? 0
    console.log(`  initial AAPL qty=${initialAaplQty}`)

    // === Stage + Commit + Push: buy 1 AAPL ===
    const addResult = uta.stagePlaceOrder({
      aliceId: `${uta.id}|AAPL`,
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 1,
    })
    expect(addResult.staged).toBe(true)
    console.log(`  staged: ok`)

    const commitResult = uta.commit('e2e: buy 1 AAPL')
    expect(commitResult.prepared).toBe(true)
    console.log(`  committed: hash=${commitResult.hash}`)

    const pushResult = await uta.push()
    console.log(`  pushed: submitted=${pushResult.submitted.length}, rejected=${pushResult.rejected.length}`)
    expect(pushResult.submitted).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)

    const buyOrderId = pushResult.submitted[0].orderId
    console.log(`  orderId: ${buyOrderId}`)
    expect(buyOrderId).toBeDefined()

    // === Sync: confirm fill ===
    const sync1 = await uta.sync({ delayMs: 2000 })
    console.log(`  sync1: updatedCount=${sync1.updatedCount}, updates=${JSON.stringify(sync1.updates.map(u => ({ s: u.symbol, from: u.previousStatus, to: u.currentStatus })))}`)
    expect(sync1.updatedCount).toBe(1)
    expect(sync1.updates[0].currentStatus).toBe('filled')

    // === Verify: position exists, no pending ===
    const state1 = await uta.getState()
    const aaplPos = state1.positions.find(p => p.contract.symbol === 'AAPL')
    console.log(`  state: AAPL qty=${aaplPos?.quantity}, pending=${state1.pendingOrders.length}`)
    expect(aaplPos).toBeDefined()
    expect(aaplPos!.quantity.toNumber()).toBe(initialAaplQty + 1)
    expect(state1.pendingOrders).toHaveLength(0)

    // === Stage + Commit + Push: close 1 AAPL ===
    uta.stageClosePosition({ aliceId: `${uta.id}|AAPL`, qty: 1 })
    uta.commit('e2e: close 1 AAPL')
    const closePush = await uta.push()
    console.log(`  close pushed: submitted=${closePush.submitted.length}`)
    expect(closePush.submitted).toHaveLength(1)

    // === Sync: confirm close fill ===
    const sync2 = await uta.sync({ delayMs: 2000 })
    console.log(`  sync2: updatedCount=${sync2.updatedCount}`)
    expect(sync2.updatedCount).toBe(1)
    expect(sync2.updates[0].currentStatus).toBe('filled')

    // === Verify: position back to initial ===
    const finalPositions = await broker.getPositions()
    const finalAaplQty = finalPositions.find(p => p.contract.symbol === 'AAPL')?.quantity.toNumber() ?? 0
    console.log(`  final AAPL qty=${finalAaplQty} (initial was ${initialAaplQty})`)
    expect(finalAaplQty).toBe(initialAaplQty)

    // === Log: 2 commits ===
    const history = uta.log()
    console.log(`  log: ${history.length} commits — [${history.map(h => h.message).join(', ')}]`)
    expect(history.length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})

// ==================== Bybit — ETH perp lifecycle ====================

describe('UTA — Bybit demo (ETH perp)', () => {
  let broker: IBroker | null = null
  let ethAliceId: string = ''

  beforeAll(async () => {
    const all = await getTestAccounts()
    const bybit = filterByProvider(all, 'ccxt').find(a => a.id.includes('bybit'))
    if (!bybit) {
      console.log('e2e: No Bybit demo account, skipping UTA Bybit tests')
      return
    }
    broker = bybit.broker

    const results = await broker.searchContracts('ETH')
    const perp = results.find(r => r.contract.localSymbol?.includes('USDT:USDT'))
    if (!perp) {
      console.log('e2e: No ETH/USDT perp found, skipping')
      broker = null
      return
    }
    // Construct aliceId in new format: {utaId}|{nativeKey}
    const nativeKey = perp.contract.localSymbol!
    ethAliceId = `${bybit.id}|${nativeKey}`
    console.log(`UTA Bybit: ETH perp aliceId=${ethAliceId}`)
  }, 60_000)

  it('full lifecycle: buy → sync → verify → close → sync → verify', async () => {
    if (!broker) { console.log('e2e: skipped — no Bybit demo account'); return }

    const uta = new UnifiedTradingAccount(broker)

    // Record initial state
    const initialPositions = await broker.getPositions()
    const initialEthQty = initialPositions.find(p => p.contract.localSymbol?.includes('USDT:USDT'))?.quantity.toNumber() ?? 0
    console.log(`  initial ETH qty=${initialEthQty}`)

    // === Stage + Commit + Push: buy 0.01 ETH ===
    const addResult = uta.stagePlaceOrder({
      aliceId: ethAliceId,
      side: 'buy',
      type: 'market',
      qty: 0.01,
    })
    expect(addResult.staged).toBe(true)
    console.log(`  staged: ok`)

    const commitResult = uta.commit('e2e: buy 0.01 ETH')
    expect(commitResult.prepared).toBe(true)
    console.log(`  committed: hash=${commitResult.hash}`)

    const pushResult = await uta.push()
    console.log(`  pushed: submitted=${pushResult.submitted.length}, rejected=${pushResult.rejected.length}`)
    expect(pushResult.submitted).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)

    const buyOrderId = pushResult.submitted[0].orderId
    console.log(`  orderId: ${buyOrderId}`)
    expect(buyOrderId).toBeDefined()

    // === Sync: confirm fill (Bybit needs more time) ===
    const sync1 = await uta.sync({ delayMs: 3000 })
    console.log(`  sync1: updatedCount=${sync1.updatedCount}, updates=${JSON.stringify(sync1.updates.map(u => ({ s: u.symbol, from: u.previousStatus, to: u.currentStatus })))}`)
    expect(sync1.updatedCount).toBe(1)
    expect(sync1.updates[0].currentStatus).toBe('filled')

    // === Verify: position exists ===
    const state1 = await uta.getState()
    const ethPos = state1.positions.find(p => p.contract.aliceId === ethAliceId)
    console.log(`  state: ETH qty=${ethPos?.quantity}, pending=${state1.pendingOrders.length}`)
    expect(ethPos).toBeDefined()
    expect(state1.pendingOrders).toHaveLength(0)

    // === Stage + Commit + Push: close 0.01 ETH ===
    uta.stageClosePosition({ aliceId: ethAliceId, qty: 0.01 })
    uta.commit('e2e: close 0.01 ETH')
    const closePush = await uta.push()
    console.log(`  close pushed: submitted=${closePush.submitted.length}`)
    expect(closePush.submitted).toHaveLength(1)

    // === Sync: confirm close fill ===
    const sync2 = await uta.sync({ delayMs: 3000 })
    console.log(`  sync2: updatedCount=${sync2.updatedCount}`)
    expect(sync2.updatedCount).toBe(1)
    expect(sync2.updates[0].currentStatus).toBe('filled')

    // === Verify: we bought 0.01 then closed 0.01, net change should be ~0 ===
    const finalPositions = await broker.getPositions()
    const finalEthQty = finalPositions.find(p => p.contract.localSymbol?.includes('USDT:USDT'))?.quantity.toNumber() ?? 0
    console.log(`  final ETH qty=${finalEthQty} (initial was ${initialEthQty})`)
    // Allow tolerance for residual positions from other test runs
    expect(Math.abs(finalEthQty - initialEthQty)).toBeLessThan(0.02)

    // === Log: 2 commits ===
    const history = uta.log()
    console.log(`  log: ${history.length} commits — [${history.map(h => h.message).join(', ')}]`)
    expect(history.length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
