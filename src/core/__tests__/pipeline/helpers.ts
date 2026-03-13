/**
 * Shared test infrastructure for message pipeline integration tests.
 *
 * FakeProvider, CapturingSession, CapturingConnector, event builders,
 * and helpers used across the pipeline-*.spec.ts files.
 */

import { vi } from 'vitest'
import { AgentCenter } from '../../agent-center.js'
import {
  GenerateRouter,
  StreamableResult,
  type GenerateProvider,
  type ProviderEvent,
  type ProviderResult,
  type GenerateInput,
  type GenerateOpts,
} from '../../ai-provider.js'
import { type Connector, type SendPayload, type SendResult } from '../../connector-center.js'
import { DEFAULT_COMPACTION_CONFIG } from '../../compaction.js'
import type { SessionStore, SessionEntry, ContentBlock } from '../../session.js'
import type { MediaAttachment } from '../../types.js'

// ==================== FakeProvider ====================

/** A FakeProvider that yields a configurable sequence of ProviderEvents. */
export class FakeProvider implements GenerateProvider {
  readonly inputKind: 'text' | 'messages'
  readonly providerTag: 'vercel-ai' | 'claude-code' | 'agent-sdk'

  constructor(
    private events: ProviderEvent[],
    opts?: { inputKind?: 'text' | 'messages'; providerTag?: 'vercel-ai' | 'claude-code' | 'agent-sdk' },
  ) {
    this.inputKind = opts?.inputKind ?? 'messages'
    this.providerTag = opts?.providerTag ?? 'vercel-ai'
  }

  async ask(_prompt: string): Promise<ProviderResult> {
    return { text: 'fake-ask', media: [] }
  }

  async *generate(_input: GenerateInput, _opts?: GenerateOpts): AsyncIterable<ProviderEvent> {
    for (const e of this.events) yield e
  }
}

// ==================== CapturingSession ====================

/** Recorded session write operation. */
export interface SessionWrite {
  method: 'appendUser' | 'appendAssistant'
  content: string | ContentBlock[]
  provider?: string
  metadata?: Record<string, unknown>
}

/** In-memory SessionStore that captures all writes. */
export function makeCapturingSession(): SessionStore & { writes: SessionWrite[] } {
  const writes: SessionWrite[] = []
  const entries: SessionEntry[] = []

  const session = {
    id: 'test-session',
    writes,
    appendUser: vi.fn(async (content: string | ContentBlock[], provider?: string) => {
      writes.push({ method: 'appendUser', content, provider })
      const e: SessionEntry = {
        type: 'user',
        message: { role: 'user', content },
        uuid: `u-${entries.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        provider: provider as SessionEntry['provider'],
      }
      entries.push(e)
      return e
    }),
    appendAssistant: vi.fn(async (content: string | ContentBlock[], provider?: string, metadata?: Record<string, unknown>) => {
      writes.push({ method: 'appendAssistant', content, provider, metadata })
      const e: SessionEntry = {
        type: 'assistant',
        message: { role: 'assistant', content },
        uuid: `a-${entries.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        provider: provider as SessionEntry['provider'],
        metadata,
      }
      entries.push(e)
      return e
    }),
    appendRaw: vi.fn(async () => {}),
    readAll: vi.fn(async () => [...entries]),
    readActive: vi.fn(async () => [...entries]),
    restore: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
  } as unknown as SessionStore & { writes: SessionWrite[] }

  return session
}

// ==================== CapturingConnector ====================

/** Captured connector call. */
export interface ConnectorCall {
  method: 'send' | 'sendStream'
  payload?: SendPayload
  stream?: StreamableResult
  meta?: Pick<SendPayload, 'kind' | 'source'>
}

/** Create a capturing Connector mock. */
export function makeCapturingConnector(opts?: {
  channel?: string
  push?: boolean
  media?: boolean
  hasSendStream?: boolean
  sendResult?: SendResult
}): Connector & { calls: ConnectorCall[] } {
  const calls: ConnectorCall[] = []
  const result = opts?.sendResult ?? { delivered: true }

  const connector: Connector & { calls: ConnectorCall[] } = {
    channel: opts?.channel ?? 'test',
    to: 'default',
    capabilities: {
      push: opts?.push ?? true,
      media: opts?.media ?? true,
    },
    calls,
    send: vi.fn(async (payload: SendPayload) => {
      calls.push({ method: 'send', payload })
      return result
    }),
  }

  if (opts?.hasSendStream !== false) {
    connector.sendStream = vi.fn(async (stream: StreamableResult, meta?: Pick<SendPayload, 'kind' | 'source'>) => {
      calls.push({ method: 'sendStream', stream, meta })
      // Drain the stream so it doesn't hang
      for await (const _e of stream) { /* drain */ }
      await stream
      return result
    })
  }

  return connector
}

// ==================== Event Builders ====================

export function textEvent(text: string): ProviderEvent {
  return { type: 'text', text }
}

export function toolUseEvent(id: string, name: string, input: unknown): ProviderEvent {
  return { type: 'tool_use', id, name, input }
}

export function toolResultEvent(toolUseId: string, content: string): ProviderEvent {
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

export function doneEvent(text: string, media: MediaAttachment[] = []): ProviderEvent {
  return { type: 'done', result: { text, media } }
}

// ==================== Helpers ====================

/** Create an AgentCenter wired to a FakeProvider. */
export function makeAgentCenter(provider: FakeProvider): AgentCenter {
  const router = new GenerateRouter(provider, null)
  return new AgentCenter({ router, compaction: DEFAULT_COMPACTION_CONFIG })
}

/** Collect all events from a StreamableResult into an array. */
export async function collectEvents(stream: StreamableResult): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}
