import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SecretsApi } from 'orca/host'
import { readBackendApiKey } from './providers'
import { resolveExecutable, spawnWithStdin } from './providers/cli-exec'
import { readCodexConfigSummary } from './providers/codex-cli'
import type { AdvisorSettings, BackendId, ModelCatalogResult, ModelOption } from './types'

const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_RETURNED_MODELS = 350

const catalogCache = new Map<string, ModelCatalogResult>()

const CURATED_OPENROUTER: ModelOption[] = [
  { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Recommended' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Recommended' },
  { id: 'openai/gpt-5.4', label: 'OpenAI GPT-5.4', group: 'Recommended' },
  { id: 'google/gemini-2.5-pro', label: 'Google Gemini 2.5 Pro', group: 'Recommended' },
  { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', group: 'Recommended' }
]

const CURATED_ANTHROPIC: ModelOption[] = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Recommended' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Recommended' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', group: 'Fast' }
]

const CURATED_OPENAI: ModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', group: 'Recommended' },
  { id: 'gpt-4.1', label: 'GPT-4.1', group: 'General' }
]

export function dedupeModels(items: ModelOption[], maxCount = MAX_RETURNED_MODELS): ModelOption[] {
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const item of items) {
    const id = item.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    const clean: ModelOption = {
      id,
      label: item.label.trim() || id || 'Default',
      ...(item.group ? { group: item.group } : {}),
      ...(item.description ? { description: item.description } : {})
    }
    out.push(clean)
    if (out.length >= maxCount) break
  }
  return out
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 5_000
): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function parseOpenAiStyleModels(raw: unknown): ModelOption[] {
  if (!raw || typeof raw !== 'object') return []
  const data = (raw as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const out: ModelOption[] = []
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const id = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id.trim() : ''
    if (!id) continue
    const displayName =
      typeof (row as { display_name?: unknown }).display_name === 'string'
        ? (row as { display_name: string }).display_name.trim()
        : typeof (row as { name?: unknown }).name === 'string'
          ? (row as { name: string }).name.trim()
          : ''
    out.push({
      id,
      label: displayName && displayName !== id ? `${displayName} (${id})` : id
    })
  }
  return out
}

function parseModelsCacheJson(raw: unknown): ModelOption[] {
  if (!raw || typeof raw !== 'object') return []
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { models?: unknown }).models)
      ? ((raw as { models: unknown[] }).models as unknown[])
      : []

  const out: ModelOption[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    if (rec.visibility === 'hide' || rec.hidden === true) continue
    const slug =
      typeof rec.slug === 'string'
        ? rec.slug.trim()
        : typeof rec.id === 'string'
          ? rec.id.trim()
          : ''
    if (!slug) continue
    const displayName =
      typeof rec.display_name === 'string'
        ? rec.display_name.trim()
        : typeof rec.name === 'string'
          ? rec.name.trim()
          : ''
    out.push({
      id: slug,
      label: displayName && displayName.toLowerCase() !== slug.toLowerCase() ? `${displayName} (${slug})` : displayName || slug
    })
  }
  return out
}

export async function listClaudeCliModels(
  settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: 'Default (Claude)' }]
  let source: 'live' | 'config' | 'curated' = 'curated'
  let note = 'Claude Code'

  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      model?: string
      env?: Record<string, string>
    }
    const env = parsed?.env ?? {}
    const configEntries: [string | undefined, string][] = [
      [env.ANTHROPIC_MODEL, 'default'],
      [env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'Opus'],
      [env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'Sonnet'],
      [env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'Haiku'],
      [parsed?.model, 'settings']
    ]

    for (const [val, tag] of configEntries) {
      if (typeof val === 'string' && val.trim()) {
        models.push({ id: val.trim(), label: `${val.trim()} (${tag})`, group: 'Configured' })
        source = 'config'
      }
    }

    const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : ''
    if (baseUrl) {
      const cleanBase = baseUrl.replace(/\/+$/, '')
      const modelsUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`
      const headers: Record<string, string> = { accept: 'application/json' }
      const token = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY.trim() : ''
      if (token) {
        headers['x-api-key'] = token
        headers.authorization = `Bearer ${token}`
      }
      const liveData = await fetchJsonWithTimeout(modelsUrl, headers, 5_000)
      const liveModels = parseOpenAiStyleModels(liveData)
      if (liveModels.length > 0) {
        models.push(...liveModels)
        source = 'live'
        note = `${liveModels.length} live models`
      } else {
        note = 'From ~/.claude/settings.json'
      }
    } else if (source === 'config') {
      note = 'From ~/.claude/settings.json'
    }
  } catch {
    // ~/.claude/settings.json absent or unreadable
  }

  // Only include built-in aliases if no live/config models were discovered
  if (models.length <= 1) {
    models.push(
      { id: 'opus', label: 'opus', group: 'Aliases' },
      { id: 'sonnet', label: 'sonnet', group: 'Aliases' },
      { id: 'haiku', label: 'haiku', group: 'Aliases' }
    )
  }

  return {
    backend: 'claude-cli',
    models: dedupeModels(models),
    source,
    fetchedAt: Date.now(),
    note
  }
}

export async function listCodexCliModels(
  configPath = path.join(os.homedir(), '.codex', 'config.toml')
): Promise<ModelCatalogResult> {
  const summary = await readCodexConfigSummary(configPath)
  const models: ModelOption[] = [
    {
      id: '',
      label: summary.defaultModel ? `Default (${summary.defaultModel})` : 'Default (Codex)'
    }
  ]

  let source: 'live' | 'config' | 'curated' = summary.defaultModel ? 'config' : 'curated'
  let note = summary.defaultModel ? `Default "${summary.defaultModel}"` : 'Codex'

  // Read real user-scoped Codex models from ~/.codex/models_cache.json
  const cachePath = path.join(path.dirname(configPath), 'models_cache.json')
  let cachedModels: ModelOption[] = []
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    cachedModels = parseModelsCacheJson(JSON.parse(raw))
  } catch {
    // models_cache.json not present
  }

  if (summary.defaultModel) {
    const matched = cachedModels.find((m) => m.id === summary.defaultModel)
    models.push({
      id: summary.defaultModel,
      label: matched ? matched.label : summary.defaultModel,
      group: 'Configured'
    })
  }

  if (cachedModels.length > 0) {
    models.push(...cachedModels)
    source = 'live'
    note = `${cachedModels.length} Codex models`
  }

  return {
    backend: 'codex-cli',
    models: dedupeModels(models),
    source,
    fetchedAt: Date.now(),
    note
  }
}

export async function listOpenCodeModels(cliName = 'opencode'): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: `Default (${cliName})` }]
  const execSpec =
    (await resolveExecutable(cliName)) ??
    (cliName === 'opencode2' ? await resolveExecutable('opencode') : null)

  if (execSpec) {
    const res = await spawnWithStdin(execSpec, ['models'], '', { timeoutMs: 12_000 })
    if (res.code === 0 && res.stdout.trim()) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.includes('/') && !l.startsWith('INFO '))
      for (const line of lines) {
        models.push({ id: line, label: line })
      }
      if (lines.length > 0) {
        return {
          backend: 'orca-agent',
          orcaAgent: cliName,
          models: dedupeModels(models, MAX_RETURNED_MODELS),
          source: 'live',
          fetchedAt: Date.now(),
          note: `${lines.length} live models`
        }
      }
    }
  }

  return {
    backend: 'orca-agent',
    orcaAgent: cliName,
    models: dedupeModels(models),
    source: 'curated',
    fetchedAt: Date.now(),
    note: `${cliName} default`
  }
}

export async function listKiloModels(): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: 'Default (Kilocode)' }]
  const execSpec = await resolveExecutable('kilo')
  if (execSpec) {
    const res = await spawnWithStdin(execSpec, ['models'], '', { timeoutMs: 12_000 })
    if (res.code === 0 && res.stdout.trim()) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[a-z0-9_~.-]+\/[a-z0-9_~./:-]+$/i.test(l))
      for (const line of lines) {
        models.push({ id: line, label: line })
      }
      if (lines.length > 0) {
        return {
          backend: 'orca-agent',
          orcaAgent: 'kilo',
          models: dedupeModels(models, MAX_RETURNED_MODELS),
          source: 'live',
          fetchedAt: Date.now(),
          note: `${lines.length} Kilo models`
        }
      }
    }
  }

  return {
    backend: 'orca-agent',
    orcaAgent: 'kilo',
    models: dedupeModels(models),
    source: 'curated',
    fetchedAt: Date.now(),
    note: 'Kilocode default'
  }
}

export async function listGrokModels(
  grokDir = path.join(os.homedir(), '.grok')
): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: 'Default (Grok)' }]
  let source: 'live' | 'config' | 'curated' = 'curated'

  // 1. Live `grok models` output (e.g. "- grok-4.7", "* grok-4.7-build-fast (default)")
  const execSpec = await resolveExecutable('grok')
  if (execSpec) {
    const res = await spawnWithStdin(execSpec, ['models'], '', {
      timeoutMs: 8_000,
      stripElectronRunAsNode: true
    })
    if (res.code === 0 && res.stdout.trim()) {
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const m = rawLine.match(/^\s*[-*]\s+([a-z0-9._:-]+)(?:\s+\(([^)]+)\))?/i)
        if (!m?.[1]) continue
        const id = m[1].trim()
        const isDef = rawLine.trim().startsWith('*') || (m[2]?.toLowerCase().includes('default') ?? false)
        if (isDef) {
          models[0] = { id: '', label: `Default (${id})` }
        }
        models.push({ id, label: isDef ? `${id} (default)` : id })
        source = 'live'
      }
    }
  }

  // 2. Fallback: read default model from ~/.grok/config.toml ([models] default = "...")
  if (models.length <= 1) {
    try {
      const toml = await fs.readFile(path.join(grokDir, 'config.toml'), 'utf8')
      const modelsBlock = toml.match(/\[models\][\s\S]*?(?=\r?\n\[|$)/)
      const defMatch = modelsBlock?.[0].match(/^\s*default\s*=\s*["']([^"']+)["']/m)
      if (defMatch?.[1]?.trim()) {
        const id = defMatch[1].trim()
        models[0] = { id: '', label: `Default (${id})` }
        models.push({ id, label: id, group: 'Configured' })
        source = 'config'
      }
    } catch {
      // ignore
    }
  }

  // 3. Also read ~/.grok/models_cache.json if populated
  try {
    const raw = await fs.readFile(path.join(grokDir, 'models_cache.json'), 'utf8')
    const parsed = parseModelsCacheJson(JSON.parse(raw))
    if (parsed.length > 0) {
      models.push(...parsed)
      source = 'live'
    }
  } catch {
    // ignore
  }

  return {
    backend: 'orca-agent',
    orcaAgent: 'grok',
    models: dedupeModels(models),
    source,
    fetchedAt: Date.now(),
    note: 'Grok'
  }
}

export async function listGeminiModels(
  geminiDir = path.join(os.homedir(), '.gemini')
): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: 'Default (Gemini)' }]
  let source: 'live' | 'config' | 'curated' = 'curated'

  try {
    const raw = await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as { model?: string | { name?: string } }
    const configured =
      typeof parsed.model === 'string'
        ? parsed.model.trim()
        : typeof parsed.model?.name === 'string'
          ? parsed.model.name.trim()
          : ''
    if (configured) {
      models[0] = { id: '', label: `Default (${configured})` }
      models.push({ id: configured, label: configured })
      source = 'config'
    }
  } catch {
    // ignore
  }

  return {
    backend: 'orca-agent',
    orcaAgent: 'gemini',
    models: dedupeModels(models),
    source,
    fetchedAt: Date.now(),
    note: 'Gemini CLI'
  }
}

export async function listClineModels(
  clineDir = path.join(os.homedir(), '.cline', 'data', 'settings')
): Promise<ModelCatalogResult> {
  const models: ModelOption[] = [{ id: '', label: 'Default (Cline)' }]
  let source: 'live' | 'config' | 'curated' = 'curated'

  try {
    const raw = await fs.readFile(path.join(clineDir, 'global-settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of ['actModeApiModelId', 'planModeApiModelId', 'apiModelId']) {
      const v = parsed[key]
      if (typeof v === 'string' && v.trim()) {
        models.push({ id: v.trim(), label: v.trim() })
        source = 'config'
      }
    }
  } catch {
    // ignore
  }

  return {
    backend: 'orca-agent',
    orcaAgent: 'cline',
    models: dedupeModels(models),
    source,
    fetchedAt: Date.now(),
    note: 'Cline'
  }
}

async function listOpenRouterModels(): Promise<ModelCatalogResult> {
  const liveRaw = await fetchJsonWithTimeout(
    'https://openrouter.ai/api/v1/models',
    { accept: 'application/json' },
    6_000
  )
  const liveModels = parseOpenAiStyleModels(liveRaw)
  if (liveModels.length > 0) {
    const merged = dedupeModels([...CURATED_OPENROUTER, ...liveModels], MAX_RETURNED_MODELS)
    return {
      backend: 'openrouter',
      models: merged,
      source: 'live',
      fetchedAt: Date.now(),
      note: `${liveModels.length} live models`
    }
  }

  return {
    backend: 'openrouter',
    models: dedupeModels(CURATED_OPENROUTER),
    source: 'curated',
    fetchedAt: Date.now(),
    note: 'Offline fallback'
  }
}

async function listAnthropicApiModels(apiKey: string | null): Promise<ModelCatalogResult> {
  if (apiKey?.trim()) {
    const liveRaw = await fetchJsonWithTimeout(
      'https://api.anthropic.com/v1/models',
      {
        accept: 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01'
      },
      6_000
    )
    const liveModels = parseOpenAiStyleModels(liveRaw)
    if (liveModels.length > 0) {
      return {
        backend: 'anthropic',
        models: dedupeModels(liveModels),
        source: 'live',
        fetchedAt: Date.now(),
        note: `${liveModels.length} live models`
      }
    }
  }

  return {
    backend: 'anthropic',
    models: dedupeModels(CURATED_ANTHROPIC),
    source: 'curated',
    fetchedAt: Date.now(),
    note: apiKey ? 'Anthropic' : 'Save API key to fetch live models'
  }
}

async function listOpenAiModels(
  apiKey: string | null,
  customBaseUrl: string
): Promise<ModelCatalogResult> {
  const cleanBase = (customBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const isDefaultOpenAi = cleanBase === 'https://api.openai.com/v1'
  if (apiKey?.trim() || !isDefaultOpenAi) {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey?.trim()) {
      headers.authorization = `Bearer ${apiKey.trim()}`
    }
    const liveRaw = await fetchJsonWithTimeout(`${cleanBase}/models`, headers, 6_000)
    const liveModels = parseOpenAiStyleModels(liveRaw)
    if (liveModels.length > 0) {
      const sorted = liveModels.sort((a, b) => a.id.localeCompare(b.id))
      return {
        backend: 'openai',
        models: dedupeModels(sorted, MAX_RETURNED_MODELS),
        source: 'live',
        fetchedAt: Date.now(),
        note: `${liveModels.length} live models`
      }
    }
  }

  return {
    backend: 'openai',
    models: dedupeModels(CURATED_OPENAI),
    source: 'curated',
    fetchedAt: Date.now(),
    note: isDefaultOpenAi ? 'Save API key to fetch live models' : cleanBase
  }
}

export function clearModelCatalogCache(): void {
  catalogCache.clear()
}

export async function listModelsForBackend(params: {
  backend: BackendId
  orcaAgent?: string
  settings: AdvisorSettings
  secrets: SecretsApi
  forceRefresh?: boolean
}): Promise<ModelCatalogResult> {
  const orcaAgent = params.orcaAgent ?? params.settings.orcaAgent
  const cacheKey =
    params.backend === 'orca-agent'
      ? `orca-agent:${orcaAgent}`
      : params.backend === 'openai'
        ? `openai:${params.settings.customBaseUrl.trim()}`
        : params.backend

  if (!params.forceRefresh) {
    const cached = catalogCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached
    }
  }

  let result: ModelCatalogResult
  switch (params.backend) {
    case 'orca-agent': {
      if (orcaAgent === 'codex') {
        const base = await listCodexCliModels()
        result = { ...base, backend: 'orca-agent', orcaAgent: 'codex' }
      } else if (orcaAgent === 'claude') {
        const base = await listClaudeCliModels()
        result = { ...base, backend: 'orca-agent', orcaAgent: 'claude' }
      } else if (orcaAgent === 'opencode' || orcaAgent === 'opencode2') {
        result = await listOpenCodeModels(orcaAgent)
      } else if (orcaAgent === 'kilo') {
        result = await listKiloModels()
      } else if (orcaAgent === 'grok') {
        result = await listGrokModels()
      } else if (orcaAgent === 'gemini') {
        result = await listGeminiModels()
      } else if (orcaAgent === 'cline') {
        result = await listClineModels()
      } else {
        result = {
          backend: 'orca-agent',
          orcaAgent,
          models: [{ id: '', label: `Default (${orcaAgent})` }],
          source: 'curated',
          fetchedAt: Date.now(),
          note: `Orca ${orcaAgent}`
        }
      }
      break
    }
    case 'claude-cli':
      result = await listClaudeCliModels()
      break
    case 'codex-cli':
      result = await listCodexCliModels()
      break
    case 'openrouter':
      result = await listOpenRouterModels()
      break
    case 'anthropic': {
      const key = await readBackendApiKey(params.secrets, 'anthropic')
      result = await listAnthropicApiModels(key)
      break
    }
    case 'openai': {
      const key = await readBackendApiKey(params.secrets, 'openai')
      result = await listOpenAiModels(key, params.settings.customBaseUrl)
      break
    }
  }

  catalogCache.set(cacheKey, result)
  return result
}
