import { extractHttpErrorMessage, type ProviderRequest, type ProviderResponse } from './types'

type ChatPart = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatPart[]
}

export async function runOpenRouter(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const apiKey = req.apiKey?.trim()
  if (!apiKey) {
    throw new Error('OpenRouter API key is missing. Add it in Advisor → Setup.')
  }

  const supportsAnthropicCache = req.model.toLowerCase().startsWith('anthropic/')
  const messages: ChatMessage[] = [
    supportsAnthropicCache
      ? {
          role: 'system',
          content: [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
        }
      : { role: 'system', content: req.systemPrompt }
  ]

  req.history.forEach((m, idx) => {
    const isLastHistory = idx === req.history.length - 1
    if (supportsAnthropicCache && isLastHistory) {
      messages.push({
        role: m.role,
        content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
      })
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  })

  messages.push({ role: 'user', content: req.userMessage })

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'http-referer': 'https://orca.dev',
      'x-title': 'Orca Agent Advisor'
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2048,
      messages
    })
  })

  const rawText = await res.text()
  if (!res.ok) {
    throw new Error(extractHttpErrorMessage(res.status, rawText))
  }

  const data = JSON.parse(rawText) as {
    model?: string
    choices?: { message?: { content?: string | ChatPart[] } }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      cost?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  }

  const rawContent = data.choices?.[0]?.message?.content
  const advice = Array.isArray(rawContent)
    ? rawContent
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim()
    : (rawContent ?? '').trim()

  if (!advice) {
    throw new Error('OpenRouter returned an empty response.')
  }

  return {
    advice,
    model: data.model ?? req.model,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens,
          costUsd: typeof data.usage.cost === 'number' ? data.usage.cost : undefined
        }
      : null
  }
}
