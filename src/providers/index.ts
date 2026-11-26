import type { SecretsApi } from 'orca/host'
import {
  isApiBackend,
  resolveEffectiveModel,
  type AdvisorSettings,
  type ApiBackendId,
  type BackendId
} from '../types'
import { runAnthropic } from './anthropic'
import { runClaudeCli } from './claude-cli'
import { runCodexCli } from './codex-cli'
import { runGeminiCli } from './gemini-cli'
import { runGrokCli } from './grok-cli'
import { runOpenAI } from './openai'
import { runOpenRouter } from './openrouter'
import { runOrcaAgent } from './orca-agent'
import type { ProviderRequest, ProviderResponse } from './types'

export type { ProviderRequest, ProviderResponse } from './types'

export function secretKeyForBackend(backend: ApiBackendId): string {
  return `apiKey:${backend}`
}

export async function readBackendApiKey(
  secrets: SecretsApi,
  backend: BackendId
): Promise<string | null> {
  if (!isApiBackend(backend)) return null
  return secrets.get(secretKeyForBackend(backend))
}

export async function callProvider(
  backend: BackendId,
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  switch (backend) {
    case 'orca-agent': {
      // Run silently in headless read-only mode (like Claude Code's /advisor) without spawning extra chat tabs in Orca.
      const agent = (req.orcaAgent ?? '').trim().toLowerCase()
      if (agent === 'codex') return runCodexCli(req, signal)
      if (agent === 'claude') return runClaudeCli(req, signal)
      if (agent === 'grok') return runGrokCli(req, signal)
      if (agent === 'gemini') return runGeminiCli(req, signal)
      return runOrcaAgent(req, signal)
    }
    case 'claude-cli':
      return runClaudeCli(req, signal)
    case 'codex-cli':
      return runCodexCli(req, signal)
    case 'openrouter':
      return runOpenRouter(req, signal)
    case 'anthropic':
      return runAnthropic(req, signal)
    case 'openai':
      return runOpenAI(req, signal)
  }
}

export async function testProviderConnection(params: {
  settings: AdvisorSettings
  secrets: SecretsApi
  backend?: BackendId
  orcaAgent?: string
  model?: string
  cwd?: string | null
}): Promise<{ ok: boolean; latencyMs: number; model: string; message: string }> {
  const backend = params.backend ?? params.settings.backend
  const orcaAgent = params.orcaAgent ?? params.settings.orcaAgent
  const effectiveModel =
    params.model?.trim() ||
    resolveEffectiveModel({
      backend,
      model: backend === params.settings.backend ? params.settings.model : '',
      modelPreset: backend === params.settings.backend ? params.settings.modelPreset : 'default'
    })
  const apiKey = await readBackendApiKey(params.secrets, backend)

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40_000)

  try {
    const res = await callProvider(
      backend,
      {
        model: effectiveModel,
        orcaAgent,
        reasoningEffort: 'low',
        apiKey,
        customBaseUrl: params.settings.customBaseUrl,
        systemPrompt: 'You are a connectivity probe. Reply with exactly OK.',
        history: [],
        userMessage: 'Reply with exactly OK.',
        cwd: params.cwd
      },
      controller.signal
    )
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: res.model,
      message: `Connected (${res.advice.slice(0, 80)})`
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: effectiveModel || (backend === 'orca-agent' ? `orca:${orcaAgent}` : backend),
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timer)
  }
}
