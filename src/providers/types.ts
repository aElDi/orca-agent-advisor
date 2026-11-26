import type { HistoryMessage } from '../threads'
import type { ReasoningEffort, UsageInfo } from '../types'

export type ProviderRequest = {
  model: string
  orcaAgent?: string
  reasoningEffort?: ReasoningEffort
  apiKey?: string | null
  customBaseUrl?: string
  systemPrompt: string
  history: HistoryMessage[]
  userMessage: string
  cwd?: string | null
  timeoutMs?: number
}

export type ProviderResponse = {
  advice: string
  model: string
  usage: UsageInfo | null
  orcaSessionId?: string
}

export function extractHttpErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const err = parsed.error
    if (typeof err === 'string') return `HTTP ${status}: ${err}`
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return `HTTP ${status}: ${(err as Record<string, unknown>).message}`
    }
    if (typeof parsed.message === 'string') return `HTTP ${status}: ${parsed.message}`
  } catch {
    // ignore JSON parse failure
  }
  const snippet = bodyText.trim().slice(0, 300)
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`
}
