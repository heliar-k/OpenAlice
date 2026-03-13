import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../../core/types.js'
import { SessionStore, type ContentBlock } from '../../core/session.js'
import type { Connector, SendPayload } from '../../core/connector-center.js'
import type { StreamableResult } from '../../core/ai-provider.js'
import { persistMedia } from '../../core/media-store.js'
import { readWebSubchannels } from '../../core/config.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from './routes/chat.js'
import { createChannelsRoutes } from './routes/channels.js'
import { createConfigRoutes, createOpenbbRoutes } from './routes/config.js'
import { createEventsRoutes } from './routes/events.js'
import { createCronRoutes } from './routes/cron.js'
import { createHeartbeatRoutes } from './routes/heartbeat.js'
import { createTradingRoutes } from './routes/trading.js'
import { createTradingConfigRoutes } from './routes/trading-config.js'
import { createDevRoutes } from './routes/dev.js'
import { createToolsRoutes } from './routes/tools.js'

export interface WebConfig {
  port: number
}

export class WebPlugin implements Plugin {
  name = 'web'
  private server: ReturnType<typeof serve> | null = null
  /** SSE clients grouped by channel ID. Default channel: 'default'. */
  private sseByChannel = new Map<string, Map<string, SSEClient>>()
  private unregisterConnector?: () => void

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    // Load sub-channel definitions
    const subChannels = await readWebSubchannels()

    // Initialize sessions for the default channel and all sub-channels
    const sessions = new Map<string, SessionStore>()

    const defaultSession = new SessionStore('web/default')
    await defaultSession.restore()
    sessions.set('default', defaultSession)

    for (const ch of subChannels) {
      const session = new SessionStore(`web/${ch.id}`)
      await session.restore()
      sessions.set(ch.id, session)
    }

    // Initialize SSE map for known channels (entries are created lazily too)
    this.sseByChannel.set('default', new Map())
    for (const ch of subChannels) {
      this.sseByChannel.set(ch.id, new Map())
    }

    const app = new Hono()

    app.onError((err: Error, c: Context) => {
      if (err instanceof SyntaxError) {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      console.error('web: unhandled error:', err)
      return c.json({ error: err.message }, 500)
    })

    app.use('/api/*', cors())

    // ==================== Mount route modules ====================
    app.route('/api/chat', createChatRoutes({ ctx, sessions, sseByChannel: this.sseByChannel }))
    app.route('/api/channels', createChannelsRoutes({ sessions, sseByChannel: this.sseByChannel }))
    app.route('/api/media', createMediaRoutes())
    app.route('/api/config', createConfigRoutes({
      onConnectorsChange: async () => { await ctx.reconnectConnectors() },
    }))
    app.route('/api/openbb', createOpenbbRoutes())
    app.route('/api/events', createEventsRoutes(ctx))
    app.route('/api/cron', createCronRoutes(ctx))
    app.route('/api/heartbeat', createHeartbeatRoutes(ctx))
    app.route('/api/trading/config', createTradingConfigRoutes(ctx))
    app.route('/api/trading', createTradingRoutes(ctx))
    app.route('/api/dev', createDevRoutes(ctx.connectorCenter))
    app.route('/api/tools', createToolsRoutes(ctx.toolCenter))

    // ==================== Serve UI (Vite build output) ====================
    const uiRoot = resolve('dist/ui')
    app.use('/*', serveStatic({ root: uiRoot }))
    app.get('*', serveStatic({ root: uiRoot, path: 'index.html' }))

    // ==================== Connector registration ====================
    // The web connector only targets the main 'default' channel (heartbeat/cron notifications).
    this.unregisterConnector = ctx.connectorCenter.register(
      this.createConnector(this.sseByChannel, defaultSession),
    )

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, port: this.config.port }, (info: { port: number }) => {
      console.log(`web plugin listening on http://localhost:${info.port}`)
    })
  }

  async stop() {
    this.sseByChannel.clear()
    this.unregisterConnector?.()
    this.server?.close()
  }

  private createConnector(
    sseByChannel: Map<string, Map<string, SSEClient>>,
    session: SessionStore,
  ): Connector {
    return {
      channel: 'web',
      to: 'default',
      capabilities: { push: true, media: true },
      send: async (payload) => {
        // Persist media to data/media/ with 3-word names
        const media: Array<{ type: 'image'; url: string }> = []
        for (const m of payload.media ?? []) {
          const name = await persistMedia(m.path)
          media.push({ type: 'image', url: `/api/media/${name}` })
        }

        const data = JSON.stringify({
          type: 'message',
          kind: payload.kind,
          text: payload.text,
          media: media.length > 0 ? media : undefined,
          source: payload.source,
        })

        // Only broadcast to default channel SSE clients (heartbeat/cron stay in main channel)
        const defaultClients = sseByChannel.get('default') ?? new Map()
        for (const client of defaultClients.values()) {
          try { client.send(data) } catch { /* client disconnected */ }
        }

        // Persist to session so history survives page refresh (text + image blocks)
        const blocks: ContentBlock[] = [
          { type: 'text', text: payload.text },
          ...media.map((m) => ({ type: 'image' as const, url: m.url })),
        ]
        await session.appendAssistant(blocks, 'notification', {
          kind: payload.kind,
          source: payload.source,
        })

        return { delivered: defaultClients.size > 0 }
      },

      sendStream: async (stream: StreamableResult, meta?: Pick<SendPayload, 'kind' | 'source'>) => {
        const defaultClients = sseByChannel.get('default') ?? new Map()

        // Push streaming events to SSE clients as they arrive
        for await (const event of stream) {
          if (event.type === 'done') continue
          const data = JSON.stringify({ type: 'stream', event })
          for (const client of defaultClients.values()) {
            try { client.send(data) } catch { /* disconnected */ }
          }
        }

        // Get completed result (resolves immediately — drain already finished)
        const result = await stream

        // Persist media
        const media: Array<{ type: 'image'; url: string }> = []
        for (const m of result.media) {
          const name = await persistMedia(m.path)
          media.push({ type: 'image', url: `/api/media/${name}` })
        }

        // Push final message to SSE (same format as send())
        const data = JSON.stringify({
          type: 'message',
          kind: meta?.kind ?? 'notification',
          text: result.text,
          media: media.length > 0 ? media : undefined,
          source: meta?.source,
        })
        for (const client of defaultClients.values()) {
          try { client.send(data) } catch { /* disconnected */ }
        }

        // Persist to session (push notifications appear in web chat history)
        const blocks: ContentBlock[] = [
          { type: 'text', text: result.text },
          ...media.map((m) => ({ type: 'image' as const, url: m.url })),
        ]
        await session.appendAssistant(blocks, 'notification', {
          kind: meta?.kind ?? 'notification',
          source: meta?.source,
        })

        return { delivered: defaultClients.size > 0 }
      },
    }
  }
}
