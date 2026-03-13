/**
 * A. AgentCenter — Session Persistence Tests
 *
 * Verifies that all event types (text, tool_use, tool_result, media)
 * are correctly persisted to the session store with proper providerTag,
 * ContentBlock[] format, and media handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentBlock } from '../../session.js'
import {
  FakeProvider,
  makeCapturingSession,
  makeAgentCenter,
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

describe('AgentCenter — session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('A1: text-only reply persists user + final assistant as ContentBlock[]', async () => {
    const provider = new FakeProvider([
      textEvent('hello'),
      doneEvent('hello'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    const stream = ac.askWithSession('prompt', session)
    await stream // drain

    const userWrites = session.writes.filter(w => w.method === 'appendUser')
    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')

    expect(userWrites.length).toBeGreaterThanOrEqual(1)
    expect(userWrites[0].content).toBe('prompt')
    expect(userWrites[0].provider).toBe('human')

    const finalWrite = assistantWrites[assistantWrites.length - 1]
    expect(finalWrite.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(finalWrite.provider).toBe('vercel-ai')
  })

  it('A2: tool loop persists intermediate tool_use/tool_result + final text', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'get_weather', { city: 'Tokyo' }),
      toolResultEvent('t1', '72°F'),
      textEvent('The weather is 72°F'),
      doneEvent('The weather is 72°F'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('weather?', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const userWrites = session.writes.filter(w => w.method === 'appendUser')

    expect(userWrites[0].content).toBe('weather?')
    expect(userWrites[0].provider).toBe('human')

    const intermediateAssistant = assistantWrites.find(w => {
      const content = w.content
      return Array.isArray(content) && content.some((b: ContentBlock) => b.type === 'tool_use')
    })
    expect(intermediateAssistant).toBeDefined()
    expect((intermediateAssistant!.content as ContentBlock[])[0]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'get_weather',
      input: { city: 'Tokyo' },
    })

    const toolResultWrite = userWrites.find(w => {
      const content = w.content
      return Array.isArray(content) && (content as ContentBlock[]).some((b: ContentBlock) => b.type === 'tool_result')
    })
    expect(toolResultWrite).toBeDefined()
    expect((toolResultWrite!.content as ContentBlock[])[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '72°F',
    })

    const finalAssistant = assistantWrites[assistantWrites.length - 1]
    expect(finalAssistant.content).toEqual([{ type: 'text', text: 'The weather is 72°F' }])
  })

  it('A3: multi-turn tools produce correct flush ordering', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'search', { q: 'a' }),
      toolResultEvent('t1', 'result-a'),
      toolUseEvent('t2', 'search', { q: 'b' }),
      toolResultEvent('t2', 'result-b'),
      textEvent('combined answer'),
      doneEvent('combined answer'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('search both', session)

    const providerWrites = session.writes.filter(w => w.provider !== 'human')

    const toolUseWrites = providerWrites.filter(w =>
      Array.isArray(w.content) && (w.content as ContentBlock[]).some(b => b.type === 'tool_use'),
    )
    expect(toolUseWrites).toHaveLength(2)
    expect(((toolUseWrites[0].content as ContentBlock[])[0] as { name: string }).name).toBe('search')
    expect(((toolUseWrites[1].content as ContentBlock[])[0] as { name: string }).name).toBe('search')

    const toolResultWrites = providerWrites.filter(w =>
      Array.isArray(w.content) && (w.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )
    expect(toolResultWrites).toHaveLength(2)
  })

  it('A4: media in done event persists image blocks in final write', async () => {
    const provider = new FakeProvider([
      textEvent('chart generated'),
      doneEvent('chart generated', [{ type: 'image', path: '/tmp/chart.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('make a chart', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    const blocks = finalWrite.content as ContentBlock[]

    expect(blocks).toEqual([
      { type: 'text', text: 'chart generated' },
      { type: 'image', url: '/api/media/2026-03-13/ace-aim-air.png' },
    ])
  })

  it('A5: media extracted from tool_result content appears in final persist', async () => {
    const toolResultContent = JSON.stringify({
      content: [{ type: 'text', text: 'MEDIA:/tmp/screenshot.png' }],
    })

    const provider = new FakeProvider([
      toolUseEvent('t1', 'screenshot', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('screenshot taken'),
      doneEvent('screenshot taken'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('take screenshot', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    const blocks = finalWrite.content as ContentBlock[]

    expect(blocks).toContainEqual({ type: 'text', text: 'screenshot taken' })
    expect(blocks).toContainEqual({ type: 'image', url: '/api/media/2026-03-13/ace-aim-air.png' })
  })

  it('A6: providerTag correctly propagates for each provider type', async () => {
    for (const tag of ['vercel-ai', 'claude-code', 'agent-sdk'] as const) {
      vi.clearAllMocks()
      const provider = new FakeProvider(
        [textEvent('hi'), doneEvent('hi')],
        { providerTag: tag },
      )
      const ac = makeAgentCenter(provider)
      const session = makeCapturingSession()

      await ac.askWithSession('test', session)

      const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
      const finalWrite = assistantWrites[assistantWrites.length - 1]
      expect(finalWrite.provider).toBe(tag)
    }
  })

  it('A7: persistMedia failure silently skips image block', async () => {
    const { persistMedia } = await import('../../media-store.js')
    vi.mocked(persistMedia).mockRejectedValueOnce(new Error('ENOENT: no such file'))

    const provider = new FakeProvider([
      textEvent('image gone'),
      doneEvent('image gone', [{ type: 'image', path: '/tmp/deleted.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('generate', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    const blocks = finalWrite.content as ContentBlock[]

    expect(blocks).toEqual([{ type: 'text', text: 'image gone' }])
  })

  it('A8: multiple media from tool_result + done event both appear in final', async () => {
    const { persistMedia } = await import('../../media-store.js')
    vi.mocked(persistMedia)
      .mockResolvedValueOnce('2026-03-13/tool-media-one.png')
      .mockResolvedValueOnce('2026-03-13/done-media-two.png')

    const toolResultContent = JSON.stringify({
      content: [{ type: 'text', text: 'MEDIA:/tmp/tool-screenshot.png' }],
    })
    const provider = new FakeProvider([
      toolUseEvent('t1', 'browser', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('done'),
      doneEvent('done', [{ type: 'image', path: '/tmp/chart.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('browse and chart', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    const blocks = finalWrite.content as ContentBlock[]

    expect(blocks).toEqual([
      { type: 'text', text: 'done' },
      { type: 'image', url: '/api/media/2026-03-13/tool-media-one.png' },
      { type: 'image', url: '/api/media/2026-03-13/done-media-two.png' },
    ])
  })

  it('A9: tool_result with base64 image data gets stripped before session persist', async () => {
    const toolResultContent = JSON.stringify([
      { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo...' } },
      { type: 'text', text: 'Screenshot captured' },
    ])

    const provider = new FakeProvider([
      toolUseEvent('t1', 'screenshot', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('ok'),
      doneEvent('ok'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('screenshot', session)

    const toolResultWrite = session.writes.find(w => {
      const content = w.content
      return Array.isArray(content) && (content as ContentBlock[]).some(b => b.type === 'tool_result')
    })
    expect(toolResultWrite).toBeDefined()

    const toolResultBlock = (toolResultWrite!.content as ContentBlock[]).find(b => b.type === 'tool_result')!
    const parsed = JSON.parse((toolResultBlock as { content: string }).content)
    expect(parsed[0]).toEqual({ type: 'text', text: '[Image saved to disk — use Read tool to view the file]' })
    expect(parsed[1]).toEqual({ type: 'text', text: 'Screenshot captured' })
  })

  it('A10: empty text response persists correctly', async () => {
    const provider = new FakeProvider([
      doneEvent(''),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    const result = await ac.askWithSession('silent', session)

    expect(result.text).toBe('')
    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const finalWrite = assistantWrites[assistantWrites.length - 1]
    expect(finalWrite.content).toEqual([{ type: 'text', text: '' }])
  })

  it('A11: provider stream without done event throws', async () => {
    const provider = new FakeProvider([
      textEvent('cut off mid-'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await expect(ac.askWithSession('test', session)).rejects.toThrow(
      'provider stream ended without done event',
    )
  })

  it('A12: multiple consecutive text events all buffered in intermediate flush', async () => {
    const provider = new FakeProvider([
      textEvent('first '),
      textEvent('second '),
      textEvent('third'),
      doneEvent('first second third'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('multi-text', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')

    const intermediateFlush = assistantWrites.find(w => {
      const content = w.content as ContentBlock[]
      return Array.isArray(content) && content.filter(b => b.type === 'text').length === 3
    })
    expect(intermediateFlush).toBeDefined()
    expect(intermediateFlush!.content).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'text', text: 'second ' },
      { type: 'text', text: 'third' },
    ])

    const finalWrite = assistantWrites[assistantWrites.length - 1]
    expect(finalWrite.content).toEqual([{ type: 'text', text: 'first second third' }])
  })

  it('A13: tool_use with complex nested input preserves structure', async () => {
    const complexInput = {
      orders: [
        { symbol: 'AAPL', qty: 10, side: 'buy', type: 'limit', price: 185.50 },
        { symbol: 'MSFT', qty: 5, side: 'sell', type: 'market' },
      ],
      options: { dryRun: true, timeInForce: 'day' },
    }

    const provider = new FakeProvider([
      toolUseEvent('t1', 'submit_orders', complexInput),
      toolResultEvent('t1', JSON.stringify({ submitted: 2 })),
      textEvent('Orders submitted'),
      doneEvent('Orders submitted'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('submit orders', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const toolUseWrite = assistantWrites.find(w =>
      Array.isArray(w.content) && (w.content as ContentBlock[]).some(b => b.type === 'tool_use'),
    )
    expect(toolUseWrite).toBeDefined()
    const toolUseBlock = (toolUseWrite!.content as ContentBlock[]).find(b => b.type === 'tool_use')!
    expect((toolUseBlock as { input: unknown }).input).toEqual(complexInput)
  })

  it('A14: text between tool_use and tool_result is captured correctly', async () => {
    const provider = new FakeProvider([
      textEvent('Let me check...'),
      toolUseEvent('t1', 'lookup', { q: 'test' }),
      toolResultEvent('t1', 'found'),
      textEvent('Based on the result: '),
      textEvent('everything looks good.'),
      doneEvent('Based on the result: everything looks good.'),
    ])
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('check', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    const firstFlush = assistantWrites.find(w => {
      const content = w.content as ContentBlock[]
      return Array.isArray(content) && content.some(b => b.type === 'tool_use') && content.some(b => b.type === 'text')
    })
    expect(firstFlush).toBeDefined()
    const blocks = firstFlush!.content as ContentBlock[]
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check...' })
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'lookup' })
  })

  it('A15: providerTag carries through to intermediate writes too', async () => {
    const provider = new FakeProvider(
      [
        toolUseEvent('t1', 'calc', { x: 1 }),
        toolResultEvent('t1', '42'),
        textEvent('answer'),
        doneEvent('answer'),
      ],
      { providerTag: 'agent-sdk' },
    )
    const ac = makeAgentCenter(provider)
    const session = makeCapturingSession()

    await ac.askWithSession('calc', session)

    const assistantWrites = session.writes.filter(w => w.method === 'appendAssistant')
    for (const w of assistantWrites) {
      expect(w.provider).toBe('agent-sdk')
    }

    const toolResultUserWrites = session.writes.filter(w =>
      w.method === 'appendUser' && Array.isArray(w.content),
    )
    for (const w of toolResultUserWrites) {
      expect(w.provider).toBe('agent-sdk')
    }
  })
})
