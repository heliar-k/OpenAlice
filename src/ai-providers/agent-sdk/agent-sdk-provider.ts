/**
 * AgentSdkProvider — GenerateProvider backed by @anthropic-ai/claude-agent-sdk.
 *
 * Slim data-source adapter: only calls the Agent SDK and yields ProviderEvents.
 * Session management (append, compact, persist) lives in AgentCenter.
 *
 * Reuses agent.json's `claudeCode` config block (allowedTools, disallowedTools, maxTurns)
 * since both providers are backed by the same Claude Code CLI.
 */

import { resolve } from 'node:path'
import type { Tool } from 'ai'
import type { ProviderResult, ProviderEvent } from '../../core/ai-provider.js'
import type { GenerateProvider, GenerateInput, GenerateOpts } from '../../core/ai-provider.js'
import type { AgentSdkConfig, AgentSdkOverride } from './query.js'
import { readAgentConfig } from '../../core/config.js'
import { extractMediaFromToolResultContent } from '../../core/media.js'
import { createChannel } from '../../core/async-channel.js'
import { askAgentSdk } from './query.js'
import { buildAgentSdkMcpServer } from './tool-bridge.js'

export class AgentSdkProvider implements GenerateProvider {
  readonly inputKind = 'text' as const
  readonly providerTag = 'agent-sdk' as const

  constructor(
    private getTools: () => Promise<Record<string, Tool>>,
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<AgentSdkConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  /** Build an in-process MCP server from ToolCenter, filtering disabled tools. */
  private async buildMcpServer(disabledTools?: string[]) {
    const tools = await this.getTools()
    return buildAgentSdkMcpServer(tools, disabledTools)
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const mcpServer = await this.buildMcpServer()
    const result = await askAgentSdk(prompt, config, undefined, mcpServer)
    return { text: result.text, media: [] }
  }

  async *generate(input: GenerateInput, opts?: GenerateOpts): AsyncGenerator<ProviderEvent> {
    if (input.kind !== 'text') throw new Error('AgentSdkProvider expects text input')

    const config = await this.resolveConfig()
    const agentSdkConfig: AgentSdkConfig = {
      ...config,
      ...(opts?.disabledTools?.length
        ? { disallowedTools: [...(config.disallowedTools ?? []), ...opts.disabledTools] }
        : {}),
      systemPrompt: input.systemPrompt ?? this.systemPrompt,
    }

    const override: AgentSdkOverride | undefined = opts?.agentSdk
    const mcpServer = await this.buildMcpServer(opts?.disabledTools)

    const channel = createChannel<ProviderEvent>()
    const media: import('../../core/types.js').MediaAttachment[] = []

    const resultPromise = askAgentSdk(
      input.prompt,
      {
        ...agentSdkConfig,
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
      },
      override,
      mcpServer,
    )

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))
    yield* channel

    const result = await resultPromise
    const prefix = result.ok ? '' : '[error] '
    yield { type: 'done', result: { text: prefix + result.text, media } }
  }

}
