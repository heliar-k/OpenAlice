/**
 * Declaration merge: adds `aliceId` to IBKR Contract class.
 *
 * aliceId is Alice's unique asset identifier: "{utaId}|{nativeKey}"
 * e.g. "alpaca-paper|META", "bybit-main|ETH/USDT:USDT"
 *
 * Constructed by UTA layer (not broker). Broker uses symbol/localSymbol for resolution.
 * The @traderalice/ibkr package stays a pure IBKR replica.
 */

import '@traderalice/ibkr'

declare module '@traderalice/ibkr' {
  interface Contract {
    aliceId?: string
  }
}
