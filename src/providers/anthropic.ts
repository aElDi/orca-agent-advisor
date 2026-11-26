import { extractHttpErrorMessage, type ProviderRequest, type ProviderResponse } from './types'

type AnthropicContentBlock = {
  type?: string
  text?: string
  cache_control?: { type: 'ephemeral' }
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export async function runAnthropic(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const apiKey = req.apiKey?.trim()
  if (!apiKey) {
    throw new Error('Anthropic API key is missing. Add it in Advisor → Setup.')
  }

  const messages: AnthropicMessage[] = req.history.map((m, idx) => {
    const isLastHistory = idx === req.history.length - 1
    if (isLastHistory) {
      return {
        role: m.role,
        content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
      }
    }
    return { role: m.role, content: m.content }
  })

  messages.push({ role: 'user', content: req.userMessage })

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: req.systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages
    })
  })

  const rawText = await res.text()
  if (!res.ok) {
    throw new Error(extractHttpErrorMessage(res.status, rawText))
  }

  const data = JSON.parse(rawText) as {
    model?: string
    content?: AnthropicContentBlock[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }

  const advice = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
    .trim()

  if (!advice) {
    throw new Error('Anthropic returned an empty response.')
  }

  return {
    advice,
    model: data.model ?? req.model,
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          cacheReadTokens: data.usage.cache_read_input_tokens,
          cacheWriteTokens: data.usage.cache_creation_input_tokens
        }
      : null
  }
}
