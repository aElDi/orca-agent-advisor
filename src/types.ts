import type { JsonValue } from 'orca/host'

export type BackendId =
  | 'orca-agent'
  | 'codex-cli'
  | 'claude-cli'
  | 'openrouter'
  | 'anthropic'
  | 'openai'
export type ApiBackendId = 'openrouter' | 'anthropic' | 'openai'
export type AdvisorLevel = 'rare' | 'balanced' | 'frequent'
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PostFinishReviewMode = 'suggest' | 'auto' | 'off'
export type ConsultSource = 'mcp' | 'manual' | 'auto-review' | 'unstick' | 'command'
export type ReviewVerdict = 'LGTM' | 'CHANGES_REQUESTED'

export const ADVISOR_LEVEL_PRESETS: Record<
  AdvisorLevel,
  {
    maxUsesPerTurn: number
    loopThreshold: number
    postFinishReviewMode: PostFinishReviewMode
    reasoningEffort: ReasoningEffort
  }
> = {
  rare: {
    maxUsesPerTurn: 2,
    loopThreshold: 4,
    postFinishReviewMode: 'off',
    reasoningEffort: 'medium'
  },
  balanced: {
    maxUsesPerTurn: 4,
    loopThreshold: 3,
    postFinishReviewMode: 'suggest',
    reasoningEffort: 'high'
  },
  frequent: {
    maxUsesPerTurn: 8,
    loopThreshold: 2,
    postFinishReviewMode: 'auto',
    reasoningEffort: 'xhigh'
  }
}

export const DEFAULT_MODELS: Record<BackendId, string> = {
  'orca-agent': '',
  'codex-cli': '',
  'claude-cli': '',
  openrouter: 'anthropic/claude-opus-4-6',
  anthropic: 'claude-opus-4-6',
  openai: 'o3'
}

export const BACKEND_LABELS: Record<BackendId, string> = {
  'orca-agent': 'Orca Agent',
  'codex-cli': 'Codex CLI',
  'claude-cli': 'Claude CLI',
  openrouter: 'OpenRouter API',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API'
}

export type OrcaInstalledAgent = {
  id: string
  name: string
  default: boolean
}

export type AdvisorSettings = {
  enabled: boolean
  advisorLevel: AdvisorLevel
  autoConnectAgents: boolean
  backend: BackendId
  orcaAgent: string
  modelPreset: string
  model: string
  reasoningEffort: ReasoningEffort
  customBaseUrl: string
  maxUsesPerTurn: number
  loopDetectionEnabled: boolean
  loopThreshold: number
  postFinishReviewMode: PostFinishReviewMode
  autoInjectReviewFixes: boolean
  minDiffLinesForReview: number
  injectPromptGuidance: boolean
  maxDiffChars: number
  redactSecrets: boolean
  notifyOnAlerts: boolean
  customSystemPrompt: string
}

export const DEFAULT_SETTINGS: AdvisorSettings = {
  enabled: true,
  advisorLevel: 'balanced',
  autoConnectAgents: true,
  backend: 'orca-agent',
  orcaAgent: 'codex',
  modelPreset: 'default',
  model: '',
  reasoningEffort: 'high',
  customBaseUrl: '',
  maxUsesPerTurn: 4,
  loopDetectionEnabled: true,
  loopThreshold: 3,
  postFinishReviewMode: 'suggest',
  autoInjectReviewFixes: false,
  minDiffLinesForReview: 20,
  injectPromptGuidance: true,
  maxDiffChars: 24000,
  redactSecrets: true,
  notifyOnAlerts: true,
  customSystemPrompt: ''
}

function asBool(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asInt(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.round(value)
  return Math.max(min, Math.min(max, n))
}

function asStr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizeSettings(raw: Record<string, JsonValue> | undefined): AdvisorSettings {
  const s = raw ?? {}
  const backendRaw = asStr(s.backend, DEFAULT_SETTINGS.backend)
  const backend: BackendId =
    backendRaw === 'orca-agent' ||
    backendRaw === 'claude-cli' ||
    backendRaw === 'codex-cli' ||
    backendRaw === 'openrouter' ||
    backendRaw === 'anthropic' ||
    backendRaw === 'openai'
      ? backendRaw
      : DEFAULT_SETTINGS.backend

  const reviewModeRaw = asStr(s.postFinishReviewMode, DEFAULT_SETTINGS.postFinishReviewMode)
  const postFinishReviewMode: PostFinishReviewMode =
    reviewModeRaw === 'suggest' || reviewModeRaw === 'auto' || reviewModeRaw === 'off'
      ? reviewModeRaw
      : DEFAULT_SETTINGS.postFinishReviewMode

  const effortRaw = asStr(s.reasoningEffort, DEFAULT_SETTINGS.reasoningEffort)
  const reasoningEffort: ReasoningEffort =
    effortRaw === 'default' ||
    effortRaw === 'low' ||
    effortRaw === 'medium' ||
    effortRaw === 'high' ||
    effortRaw === 'xhigh' ||
    effortRaw === 'max'
      ? effortRaw
      : DEFAULT_SETTINGS.reasoningEffort

  const levelRaw = asStr(s.advisorLevel, DEFAULT_SETTINGS.advisorLevel)
  const advisorLevel: AdvisorLevel =
    levelRaw === 'rare' || levelRaw === 'balanced' || levelRaw === 'frequent'
      ? levelRaw
      : DEFAULT_SETTINGS.advisorLevel

  return {
    enabled: asBool(s.enabled, DEFAULT_SETTINGS.enabled),
    advisorLevel,
    autoConnectAgents: asBool(s.autoConnectAgents, DEFAULT_SETTINGS.autoConnectAgents),
    backend,
    orcaAgent: asStr(s.orcaAgent, DEFAULT_SETTINGS.orcaAgent).trim() || DEFAULT_SETTINGS.orcaAgent,
    modelPreset: asStr(s.modelPreset, DEFAULT_SETTINGS.modelPreset).trim() || 'default',
    model: asStr(s.model, DEFAULT_SETTINGS.model).trim(),
    reasoningEffort,
    customBaseUrl: asStr(s.customBaseUrl, DEFAULT_SETTINGS.customBaseUrl).trim(),
    maxUsesPerTurn: asInt(s.maxUsesPerTurn, DEFAULT_SETTINGS.maxUsesPerTurn, 0, 20),
    loopDetectionEnabled: asBool(s.loopDetectionEnabled, DEFAULT_SETTINGS.loopDetectionEnabled),
    loopThreshold: asInt(s.loopThreshold, DEFAULT_SETTINGS.loopThreshold, 2, 10),
    postFinishReviewMode,
    autoInjectReviewFixes: asBool(s.autoInjectReviewFixes, DEFAULT_SETTINGS.autoInjectReviewFixes),
    minDiffLinesForReview: asInt(
      s.minDiffLinesForReview,
      DEFAULT_SETTINGS.minDiffLinesForReview,
      1,
      1000
    ),
    injectPromptGuidance: asBool(s.injectPromptGuidance, DEFAULT_SETTINGS.injectPromptGuidance),
    maxDiffChars: asInt(s.maxDiffChars, DEFAULT_SETTINGS.maxDiffChars, 4000, 120000),
    redactSecrets: asBool(s.redactSecrets, DEFAULT_SETTINGS.redactSecrets),
    notifyOnAlerts: asBool(s.notifyOnAlerts, DEFAULT_SETTINGS.notifyOnAlerts),
    customSystemPrompt: asStr(s.customSystemPrompt, DEFAULT_SETTINGS.customSystemPrompt).slice(0, 4000)
  }
}

export function resolveEffectiveModel(
  settings: Pick<AdvisorSettings, 'backend' | 'model' | 'modelPreset'>
): string {
  const custom = settings.model.trim()
  if (custom.length > 0) return custom
  const preset = settings.modelPreset?.trim() ?? 'default'
  if (preset && preset !== 'default' && preset !== 'custom') return preset
  return DEFAULT_MODELS[settings.backend]
}

export function isApiBackend(backend: BackendId): backend is ApiBackendId {
  return backend === 'openrouter' || backend === 'anthropic' || backend === 'openai'
}

export type ContextSummary = {
  branch: string | null
  headSha: string | null
  diffAdded: number
  diffRemoved: number
  diffFiles: number
  diffTruncated: boolean
  filesIncluded: string[]
  filesSkipped: string[]
  terminalLines: number
}

export type UsageInfo = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
}

export type ThreadEntry = {
  id: string
  at: number
  source: ConsultSource
  agent: string | null
  question: string
  advice: string
  backend: BackendId
  model: string
  latencyMs: number
  usage: UsageInfo | null
  context: ContextSummary
  verdict: ReviewVerdict | null
  orcaSessionId?: string
  error?: string
}

export type WorkspaceThread = {
  workspaceId: string
  branch: string | null
  updatedAt: number
  entries: ThreadEntry[]
  turnMcpUses: number
  reviewedDiffHashes: string[]
}

export type LoopAlert = {
  terminalId: string
  agent: string
  tool: string
  count: number
  lastInputSummary: string
  at: number
}

export type PendingReviewAlert = {
  workspaceId: string
  terminalId: string
  diffHash: string
  added: number
  removed: number
  files: number
  at: number
}

export type ActiveRequest = {
  requestId: string
  workspaceId: string
  source: ConsultSource
  agent: string | null
  question: string
  startedAt: number
}

export type GlobalStats = {
  totalCalls: number
  mcpCalls: number
  manualCalls: number
  autoReviewCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCostUsd: number
  loopAlerts: number
}

export type TerminalRef = {
  id: string
  title?: string
}

export type ModelOption = {
  id: string
  label: string
  group?: string
  description?: string
}

export type ModelCatalogResult = {
  backend: BackendId
  orcaAgent?: string
  models: ModelOption[]
  source: 'live' | 'config' | 'curated'
  fetchedAt: number
  note?: string
}

export type ModelsByBackend = Record<string, string>

export type AutoSetupSummary = {
  connectedAgents: string[]
  skillInstalled: boolean
}

export type WorkspaceSnapshot = {
  workspaceId: string | null
  displayName: string | null
  branch: string | null
  terminals: TerminalRef[]
  thread: WorkspaceThread | null
  activeRequest: ActiveRequest | null
  loopAlert: LoopAlert | null
  pendingReview: PendingReviewAlert | null
  lastError: string | null
  settings: AdvisorSettings
  modelsByBackend: ModelsByBackend
  installedOrcaAgents: OrcaInstalledAgent[]
  autoSetup: AutoSetupSummary
  stats: GlobalStats
}

export type AgentSetupInfo = {
  id: 'claude' | 'codex' | 'opencode'
  label: string
  installed: boolean
  commandPath: string | null
  mcpConfigured: boolean
  detail: string
}

export type SetupStatus = {
  ipcRunning: boolean
  ipcPort: number | null
  ipcFile: string
  mcpScriptPath: string
  secretsProtection: 'os-keyring' | 'unavailable'
  savedKeys: {
    openrouter: boolean
    anthropic: boolean
    openai: boolean
  }
  agents: AgentSetupInfo[]
  workspaceMcpJson: {
    path: string | null
    configured: boolean
  }
  globalSkill: {
    path: string
    installed: boolean
  }
  manualSnippetJson: string
}
