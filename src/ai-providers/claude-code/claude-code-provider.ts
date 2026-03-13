/**
 * ClaudeCodeProvider — GenerateProvider backed by the Claude Code CLI.
 *
 * Slim data-source adapter: only calls the CLI and yields ProviderEvents.
 * Session management (append, compact, persist) lives in AgentCenter.
 *
 * Agent config (evolutionMode, allowedTools, disallowedTools) is re-read from
 * disk on every request so that Web UI changes take effect without restart.
 */

import { resolve } from 'node:path'
import type { ProviderResult, ProviderEvent } from '../../core/ai-provider.js'
import type { GenerateProvider, GenerateInput, GenerateOpts } from '../../core/ai-provider.js'
import type { ClaudeCodeConfig } from './types.js'
import { readAgentConfig } from '../../core/config.js'
import { extractMediaFromToolResultContent } from '../../core/media.js'
import { createChannel } from '../../core/async-channel.js'
import { askClaudeCode } from './provider.js'

export class ClaudeCodeProvider implements GenerateProvider {
  readonly inputKind = 'text' as const
  readonly providerTag = 'claude-code' as const

  constructor(
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<ClaudeCodeConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askClaudeCode(prompt, config)
    return { text: result.text, media: [] }
  }

  async *generate(input: GenerateInput, opts?: GenerateOpts): AsyncGenerator<ProviderEvent> {
    if (input.kind !== 'text') throw new Error('ClaudeCodeProvider expects text input')

    const config = await this.resolveConfig()
    const claudeCode: ClaudeCodeConfig = {
      ...config,
      ...(opts?.disabledTools?.length
        ? { disallowedTools: [...(config.disallowedTools ?? []), ...opts.disabledTools] }
        : {}),
      systemPrompt: input.systemPrompt ?? this.systemPrompt,
    }

    const channel = createChannel<ProviderEvent>()
    const media: import('../../core/types.js').MediaAttachment[] = []

    const resultPromise = askClaudeCode(input.prompt, {
      ...claudeCode,
      onToolUse: ({ id, name, input: toolInput }) => {
        channel.push({ type: 'tool_use', id, name, input: toolInput })
      },
      onToolResult: ({ toolUseId, content }) => {
        media.push(...extractMediaFromToolResultContent(content))
        channel.push({ type: 'tool_result', tool_use_id: toolUseId, content })
      },
      onText: (text) => {
        channel.push({ type: 'text', text })
      },
    })

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))
    yield* channel

    const result = await resultPromise
    const prefix = result.ok ? '' : '[error] '
    yield { type: 'done', result: { text: prefix + result.text, media } }
  }

}
