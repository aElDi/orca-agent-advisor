import { extractHttpErrorMessage, type ProviderRequest, type ProviderResponse } from './types'

function isReasoningModel(model: string): boolean {
  const short = model.includes('/') ? model.split('/').pop() ?? model : model
  return /^(?:o[1-9]|gpt-5)/i.test(short)
}

export async function runOpenAI(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const apiKey = req.apiKey?.trim()
  const baseUrl = (req.customBaseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')

  if (!apiKey && baseUrl === 'https://api.openai.com/v1') {
    throw new Error('OpenAI API key is missing. Add it in Advisor → Setup.')
  }

  const reasoning = isReasoningModel(req.model)
  const messages = [
    { role: reasoning ? 'developer' : 'system', content: req.systemPrompt },
    ...req.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: req.userMessage }
  ]

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  }
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const payload: Record<string, unknown> = {
    model: req.model,
    messages
  }
  if (reasoning) {
    payload.max_completion_tokens = 4096
  } else {
    payload.max_tokens = 2048
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify(payload)
  })

  const rawText = await res.text()
  if (!res.ok) {
    throw new Error(extractHttpErrorMessage(res.status, rawText))
  }

  const data = JSON.parse(rawText) as {
    model?: string
    choices?: { message?: { content?: string | { text?: string }[] } }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  }

  const rawContent = data.choices?.[0]?.message?.content
  const advice = Array.isArray(rawContent)
    ? rawContent
        .map((p) => p.text ?? '')
        .join('\n')
        .trim()
    : (rawContent ?? '').trim()

  if (!advice) {
    throw new Error('OpenAI returned an empty response.')
  }

  return {
    advice,
    model: data.model ?? req.model,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens
        }
      : null
  }
}
