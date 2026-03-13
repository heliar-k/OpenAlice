/**
 * D. End-to-End Flow Tests
 *
 * Verifies complete message paths: user chat (AgentCenter → session + stream),
 * notification (AgentCenter → ConnectorCenter → connector.send),
 * streaming notification, and media end-to-end flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConnectorCenter } from '../../connector-center.js'
import {
  FakeProvider,
  makeCapturingSession,
  makeCapturingConnector,
  makeAgentCenter,
  collectEvents,
  textEvent,
  toolUseEvent,
  toolResultEvent,
  doneEvent,
} from './helpers.js'

// ==================== Module Mocks ====================

vi.mock('../../compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../compaction.js')>()
  return {
    ...actual,
    compactIfNeeded: vi.fn().mockResolvedValue({ compacted: false, method: 'none' }),
  }
})

vi.mock('../../media-store.js', () => ({
  persistMedia: vi.fn().mockResolvedValue('2026-03-13/ace-aim-air.png'),
  resolveMediaPath: vi.fn((name: string) => `/mock/media/${name}`),
}))

vi.mock('../../../ai-providers/log-tool-call.js', () => ({
  logToolCall: vi.fn(),
}))

// ==================== Tests ====================

describe('End-to-end flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('D1: user chat path — askWithSession produces correct session writes + stream events', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'lookup', { symbol: 'AAPL' }),
      toolResultEvent('t1', 'price: $185'),
      textEvent('AAPL is at $185'),
      doneEvent('AAPL is at $185'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    const stream = ac.askWithSession('what is AAPL?', session)
    const events = await collectEvents(stream)

    const result = await stream

    expect(events.map(e => e.type)).toEqual([
      'tool_use', 'tool_result', 'text', 'done',
    ])

    expect(result.text).toBe('AAPL is at $185')

    const userWrites = session.writes.filter(w => w.method === 'appendUser')
    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')

    expect(userWrites.length).toBeGreaterThanOrEqual(2)
    expect(assistantWrites.length).toBeGreaterThanOrEqual(2)

    const finalWrite = assistantWrites[assistantWrites.length - 1]
    expect(finalWrite.content).toEqual([{ type: 'text', text: 'AAPL is at $185' }])
    expect(finalWrite.provider).toBe('vercel-ai')
  })

  it('D2: notification path — agent result delivered via connector.send', async () => {
    const provider = new FakeProvider([
      textEvent('market alert: AAPL up 5%'),
      doneEvent('market alert: AAPL up 5%'),
    ])
    const ac = makeAgentCenter(provider)
    const heartbeatSession = makeCapturingSession()

    const result = await ac.askWithSession('check market', heartbeatSession)

    const cc = new ConnectorCenter()
    const webConnector = makeCapturingConnector({ channel: 'web' })
    cc.register(webConnector)

    await cc.notify(result.text, { media: result.media, source: 'heartbeat' })

    expect(webConnector.calls).toHaveLength(1)
    expect(webConnector.calls[0].payload!.text).toBe('market alert: AAPL up 5%')
    expect(webConnector.calls[0].payload!.kind).toBe('notification')
    expect(webConnector.calls[0].payload!.source).toBe('heartbeat')

    const hbAssistant = heartbeatSession.writes.filter(w => w.method === 'appendAssistant')
    expect(hbAssistant.length).toBeGreaterThanOrEqual(1)
  })

  it('D3: streaming notification path — askWithSession result streamed via connector.sendStream', async () => {
    const provider = new FakeProvider([
      textEvent('streaming notification'),
      doneEvent('streaming notification'),
    ])
    const ac = makeAgentCenter(provider)
    const cronSession = makeCapturingSession()

    const stream = ac.askWithSession('run cron task', cronSession)

    const cc = new ConnectorCenter()
    const webConnector = makeCapturingConnector({ channel: 'web', hasSendStream: true })
    cc.register(webConnector)

    await cc.notifyStream(stream, { source: 'cron' })

    expect(webConnector.calls).toHaveLength(1)
    expect(webConnector.calls[0].method).toBe('sendStream')
    expect(webConnector.calls[0].meta).toEqual({ kind: 'notification', source: 'cron' })

    const cronAssistant = cronSession.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = cronAssistant[cronAssistant.length - 1]
    expect(finalWrite.content).toEqual([{ type: 'text', text: 'streaming notification' }])
  })

  it('D4: media flows end-to-end from provider through AgentCenter to connector', async () => {
    const provider = new FakeProvider([
      textEvent('chart ready'),
      doneEvent('chart ready', [{ type: 'image', path: '/tmp/chart.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    const result = await ac.askWithSession('make chart', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    expect(finalWrite.content).toEqual([
      { type: 'text', text: 'chart ready' },
      { type: 'image', url: '/api/media/2026-03-13/ace-aim-air.png' },
    ])

    expect(result.mediaUrls).toEqual(['/api/media/2026-03-13/ace-aim-air.png'])

    const cc = new ConnectorCenter()
    const connector = makeCapturingConnector({ channel: 'web' })
    cc.register(connector)

    await cc.notify(result.text, { media: result.media, source: 'heartbeat' })

    const payload = connector.calls[0].payload!
    expect(payload.text).toBe('chart ready')
    expect(payload.media).toEqual([{ type: 'image', path: '/tmp/chart.png' }])
  })
})
