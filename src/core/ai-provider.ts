/**
 * AI Provider abstraction — GenerateProvider + GenerateRouter.
 *
 * GenerateProvider is a slim data-source adapter: each backend (Vercel AI SDK,
 * Claude Code CLI, Agent SDK) implements `ask()` and `generate()`.
 * Session management lives in AgentCenter, not here.
 *
 * GenerateRouter reads runtime config and resolves to the correct provider.
 */

import type { SessionStore } from './session.js'
import type { SDKModelMessage } from './session.js'
import type { CompactionConfig, CompactionResult } from './compaction.js'
import type { MediaAttachment } from './types.js'
import { readAIProviderConfig } from './config.js'

// ==================== Provider Events ====================

/** Streaming event emitted by AI providers during generation. */
export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== StreamableResult ====================

/**
 * A result that is both PromiseLike (for backward-compatible `await`)
 * and AsyncIterable (for real-time event streaming).
 *
 * Internally drains the source AsyncIterable in the background, buffering
 * events. Multiple consumers can iterate independently (each gets its own cursor).
 */
export class StreamableResult implements PromiseLike<ProviderResult>, AsyncIterable<ProviderEvent> {
  private _events: ProviderEvent[] = []
  private _done = false
  private _result: ProviderResult | null = null
  private _error: Error | null = null
  private _waiters: Array<() => void> = []
  private _promise: Promise<ProviderResult>

  constructor(source: AsyncIterable<ProviderEvent>) {
    this._promise = this._drain(source)
  }

  private async _drain(source: AsyncIterable<ProviderEvent>): Promise<ProviderResult> {
    try {
      for await (const event of source) {
        this._events.push(event)
        if (event.type === 'done') this._result = event.result
        this._notify()
      }
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err))
      this._notify()
      throw this._error
    } finally {
      this._done = true
      this._notify()
    }
    if (!this._result) throw new Error('StreamableResult: stream ended without done event')
    return this._result
  }

  private _notify(): void {
    for (const w of this._waiters.splice(0)) w()
  }

  then<T1 = ProviderResult, T2 = never>(
    onfulfilled?: ((value: ProviderResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this._promise.then(onfulfilled, onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ProviderEvent> {
    let cursor = 0
    while (true) {
      while (cursor < this._events.length) {
        yield this._events[cursor++]
      }
      if (this._done) return
      if (this._error) throw this._error
      await new Promise<void>((resolve) => this._waiters.push(resolve))
    }
  }
}

// ==================== Types ====================

export interface AskOptions {
  /**
   * Preamble text describing the conversation context.
   * Claude Code: injected inside the `<chat_history>` text block.
   * Vercel AI SDK: not used (native ModelMessage[] carries the history directly).
   */
  historyPreamble?: string
  /**
   * System prompt override for this call.
   * Claude Code: passed as `--system-prompt` to the CLI.
   * Vercel AI SDK: replaces the agent's `instructions` for this call (triggers agent re-creation if changed).
   */
  systemPrompt?: string
  /**
   * Max text history entries to include in context.
   * Claude Code: limits entries in the `<chat_history>` block. Default: 50.
   * Vercel AI SDK: not used (compaction via `compactIfNeeded` controls context size).
   */
  maxHistoryEntries?: number
  /**
   * Tool names to disable for this call, in addition to the global disabled list.
   * Claude Code: merged into `disallowedTools` CLI option.
   * Vercel AI SDK: filtered out from the tool map before the agent is created.
   */
  disabledTools?: string[]
  /**
   * AI provider to use for this call, overriding the global ai-provider.json config.
   * Falls back to global config if not specified.
   */
  provider?: 'claude-code' | 'vercel-ai-sdk' | 'agent-sdk'
  /**
   * Vercel AI SDK model override — per-request provider/model/baseUrl/apiKey.
   * Only used when the active backend is 'vercel-ai-sdk'.
   */
  vercelAiSdk?: {
    provider: string
    model: string
    baseUrl?: string
    apiKey?: string
  }
  /**
   * Agent SDK model override — per-request model/apiKey/baseUrl.
   * Only used when the active backend is 'agent-sdk'.
   */
  agentSdk?: {
    model?: string
    apiKey?: string
    baseUrl?: string
  }
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
  mediaUrls?: string[]
}

// ==================== GenerateProvider ====================

/**
 * Input prepared by AgentCenter, dispatched by provider.inputKind.
 *
 * - 'text': Claude Code / Agent SDK — single string prompt with <chat_history> baked in.
 * - 'messages': Vercel AI SDK — structured ModelMessage[] (history carried natively).
 */
export type GenerateInput =
  | { kind: 'text'; prompt: string; systemPrompt?: string }
  | { kind: 'messages'; messages: SDKModelMessage[]; systemPrompt?: string }

/** Per-request options passed through to the underlying provider. */
export interface GenerateOpts {
  disabledTools?: string[]
  vercelAiSdk?: { provider: string; model: string; baseUrl?: string; apiKey?: string }
  agentSdk?: { model?: string; apiKey?: string; baseUrl?: string }
}

/**
 * Slim provider interface — pure data-source adapter.
 *
 * Does NOT touch session management. AgentCenter prepares the input,
 * the provider calls the backend and yields ProviderEvents.
 */
export interface GenerateProvider {
  /** Which input format this provider expects. */
  readonly inputKind: 'text' | 'messages'
  /** Session log provenance tag. */
  readonly providerTag: 'vercel-ai' | 'claude-code' | 'agent-sdk'
  /** Stateless one-shot prompt (used for compaction summarization, etc.). */
  ask(prompt: string): Promise<ProviderResult>
  /** Stream events from the backend. Yields tool_use/tool_result/text, then done. */
  generate(input: GenerateInput, opts?: GenerateOpts): AsyncIterable<ProviderEvent>
  /**
   * Optional: custom compaction strategy. If implemented, AgentCenter delegates
   * compaction to the provider instead of using the default compactIfNeeded.
   *
   * Use case: providers with native server-side compaction (e.g. Anthropic API
   * compact-2026-01-12) can bypass the local JSONL-based summarization.
   */
  compact?(session: SessionStore, config: CompactionConfig): Promise<CompactionResult>
}

// ==================== GenerateRouter ====================

/** Reads runtime AI config and resolves to the correct GenerateProvider. */
export class GenerateRouter {
  constructor(
    private vercel: GenerateProvider,
    private claudeCode: GenerateProvider | null,
    private agentSdk: GenerateProvider | null = null,
  ) {}

  /** Resolve the active provider, optionally overridden per-request. */
  async resolve(override?: string): Promise<GenerateProvider> {
    if (override === 'agent-sdk' && this.agentSdk) return this.agentSdk
    if (override === 'claude-code' && this.claudeCode) return this.claudeCode
    if (override === 'vercel-ai-sdk') return this.vercel

    const config = await readAIProviderConfig()
    if (config.backend === 'agent-sdk' && this.agentSdk) return this.agentSdk
    if (config.backend === 'claude-code' && this.claudeCode) return this.claudeCode
    return this.vercel
  }

  /** Stateless ask — delegates to the resolved provider. */
  async ask(prompt: string): Promise<ProviderResult> {
    const provider = await this.resolve()
    return provider.ask(prompt)
  }
}
