import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Disposable, JsonValue } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import { AdvisorEngine } from './advisor'
import { computeDiffStats, isPathInside } from './context'
import { LoopTracker, TurnTracker } from './guards'
import {
  getDiscoveryFilePath,
  startIpcServer,
  type IpcConsultPayload,
  type IpcConsultResult,
  type IpcServerHandle
} from './ipc'
import { ensureAutoSetup, getSetupStatus, installGlobalSkill, installMcpTarget } from './mcp-setup'
import { clearModelCatalogCache, listModelsForBackend } from './models'
import { secretKeyForBackend, testProviderConnection } from './providers'
import { listInstalledOrcaAgents, openAdvisorPanel } from './providers/orca-agent'
import './protocol'
import {
  deleteWorkspaceThread,
  loadStats,
  loadThread,
  markDiffReviewed,
  recordLoopStat,
  resetTurnBudget,
  resetWorkspaceThread
} from './threads'
import {
  ADVISOR_LEVEL_PRESETS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveEffectiveModel,
  type ActiveRequest,
  type AdvisorLevel,
  type AdvisorSettings,
  type AutoSetupSummary,
  type BackendId,
  type ConsultSource,
  type LoopAlert,
  type ModelsByBackend,
  type OrcaInstalledAgent,
  type PendingReviewAlert,
  type TerminalRef,
  type WorkspaceSnapshot,
  type WorkspaceThread
} from './types'

type ResolvedWorkspace = {
  workspaceId: string | null
  displayName: string | null
  path: string | null
  branch: string | null
  terminals: TerminalRef[]
}

let activeDeactivate: (() => Promise<void>) | null = null

export async function deactivate(): Promise<void> {
  if (activeDeactivate) {
    const fn = activeDeactivate
    activeDeactivate = null
    await fn()
  }
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (activeDeactivate) {
    await deactivate()
  }

  const disposables: Disposable[] = []
  const engine = new AdvisorEngine()
  const loopTracker = new LoopTracker()
  const turnTracker = new TurnTracker()

  const activeRequests = new Map<string, ActiveRequest>()
  const loopAlerts = new Map<string, LoopAlert>()
  const pendingReviews = new Map<string, PendingReviewAlert>()
  const lastErrors = new Map<string, string>()

  let cachedSettings: AdvisorSettings = { ...DEFAULT_SETTINGS }
  let ipcHandle: IpcServerHandle | null = null
  let focusedWorkspaceId: string | null = null
  let autoSetupSummary: AutoSetupSummary = { connectedAgents: [], skillInstalled: false }

  async function refreshSettings(): Promise<AdvisorSettings> {
    try {
      const raw = await orca.settings.get()
      cachedSettings = normalizeSettings(raw)
    } catch {
      // keep existing cachedSettings if host cannot provide settings yet
    }
    return cachedSettings
  }

  async function resolveWorkspace(
    preferredWorkspaceId?: string | null,
    cwdHint?: string | null
  ): Promise<ResolvedWorkspace> {
    let focusedCtx: {
      workspaceId?: string
      branch: string
      displayName: string
      terminals: { id: string; title?: string }[]
    } | null = null

    try {
      focusedCtx = await orca.host.call('workspace.readContext', {})
    } catch {
      focusedCtx = null
    }

    if (focusedCtx?.workspaceId) {
      focusedWorkspaceId = focusedCtx.workspaceId
    }

    let listWorkspaces: {
      id: string
      name: string
      path: string
      branch: string | null
    }[] = []

    try {
      const listRes = await orca.host.call('workspace.list', {})
      listWorkspaces = listRes?.workspaces ?? []
    } catch {
      listWorkspaces = []
    }

    let matched: {
      id: string
      name: string
      path: string
      branch: string | null
    } | null = null

    if (preferredWorkspaceId) {
      matched = listWorkspaces.find((w) => w.id === preferredWorkspaceId) ?? null
    }

    if (!matched && cwdHint) {
      let normCwd = path.resolve(cwdHint)
      try {
        normCwd = await fs.realpath(normCwd)
      } catch {
        // keep resolved path
      }
      let bestLen = -1
      for (const w of listWorkspaces) {
        if (!w.path) continue
        let normWs = path.resolve(w.path)
        try {
          normWs = await fs.realpath(normWs)
        } catch {
          // keep resolved path
        }
        if (isPathInside(normWs, normCwd) && normWs.length > bestLen) {
          bestLen = normWs.length
          matched = w
        }
      }
    }

    if (!matched && focusedCtx?.workspaceId) {
      matched = listWorkspaces.find((w) => w.id === focusedCtx.workspaceId) ?? null
    }

    const targetId = preferredWorkspaceId || matched?.id || focusedCtx?.workspaceId || null
    const isFocused = Boolean(targetId && focusedCtx?.workspaceId === targetId)

    let terminals: TerminalRef[] = isFocused ? focusedCtx?.terminals ?? [] : []
    if (!isFocused && targetId && orca.host.has('terminal.list')) {
      try {
        const termRes = await orca.host.call('terminal.list', { workspaceId: targetId })
        terminals = termRes?.terminals ?? []
      } catch {
        terminals = []
      }
    }

    const focusedDisplay = focusedCtx ? focusedCtx.displayName : null
    const focusedBranch = focusedCtx ? focusedCtx.branch : null
    const resolvedName = matched ? matched.name : null
    const resolvedPath = matched ? matched.path : null
    const resolvedBranch = matched ? matched.branch : null

    return {
      workspaceId: targetId,
      displayName: resolvedName ?? (isFocused ? focusedDisplay : null) ?? targetId,
      path: resolvedPath,
      branch: resolvedBranch ?? (isFocused ? focusedBranch : null),
      terminals: terminals.map((t) =>
        typeof t.title === 'string' ? { id: t.id, title: t.title } : { id: t.id }
      )
    }
  }

  const MODELS_PREF_KEY = 'prefs:modelsByBackend'

  function modelPrefKey(backend: BackendId, orcaAgent?: string): string {
    return backend === 'orca-agent' ? `orca-agent:${orcaAgent || 'codex'}` : backend
  }

  async function loadModelsByBackend(): Promise<ModelsByBackend> {
    try {
      const raw = await orca.storage.get(MODELS_PREF_KEY)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out: ModelsByBackend = {}
      for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof val === 'string') out[k] = val
      }
      return out
    } catch {
      return {}
    }
  }

  async function saveModelsByBackend(map: ModelsByBackend): Promise<void> {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string') clean[k] = v
    }
    await orca.storage.set(MODELS_PREF_KEY, clean as unknown as JsonValue)
  }

  async function buildSnapshot(preferredWorkspaceId?: string | null): Promise<WorkspaceSnapshot> {
    const skipExternalOrcaCli =
      process.env.AGENT_ADVISOR_DISABLE_IPC === '1' ||
      (Boolean(process.env.NODE_TEST_CONTEXT) && process.env.ADVISOR_LIVE_E2E !== '1')

    const [ws, settings, stats, modelsByBackend, installedOrcaAgents] = await Promise.all([
      resolveWorkspace(preferredWorkspaceId),
      refreshSettings(),
      loadStats(orca.storage),
      loadModelsByBackend(),
      skipExternalOrcaCli
        ? Promise.resolve<OrcaInstalledAgent[]>([])
        : listInstalledOrcaAgents(false, (m) => orca.log(m)).catch(() => [])
    ])

    let thread: WorkspaceThread | null = null
    if (ws.workspaceId) {
      thread = await loadThread(orca.storage, ws.workspaceId, ws.branch)
    }

    const workspaceId = ws.workspaceId
    return {
      workspaceId,
      displayName: ws.displayName,
      branch: thread?.branch ?? ws.branch,
      terminals: ws.terminals,
      thread,
      activeRequest: workspaceId ? activeRequests.get(workspaceId) ?? null : null,
      loopAlert: workspaceId ? loopAlerts.get(workspaceId) ?? null : null,
      pendingReview: workspaceId ? pendingReviews.get(workspaceId) ?? null : null,
      lastError: workspaceId ? lastErrors.get(workspaceId) ?? null : null,
      settings,
      modelsByBackend,
      installedOrcaAgents,
      autoSetup: autoSetupSummary,
      stats
    }
  }

  async function updateStatusBarForSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    let text = snap.settings.enabled ? 'Advisor' : 'Advisor · Off'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = 'Open Agent Advisor panel (Mod+Shift+A)'

    if (!snap.settings.enabled) {
      tooltip = 'Agent Advisor is paused — click to open panel'
    } else if (snap.activeRequest) {
      text = 'Advisor · Thinking...'
      tone = 'accent'
      const target =
        snap.settings.backend === 'orca-agent'
          ? snap.settings.orcaAgent
          : resolveEffectiveModel(snap.settings) || snap.settings.backend
      tooltip = `Advisor (${target}) is answering — click to open panel`
    } else if (snap.loopAlert) {
      text = `Advisor · Loop (${snap.loopAlert.count}x)`
      tone = 'warning'
      tooltip = `Repeated ${snap.loopAlert.tool} detected — click to open Advisor panel`
    } else if (snap.pendingReview) {
      text = `Advisor · Review (+${snap.pendingReview.added}/-${snap.pendingReview.removed})`
      tone = 'accent'
      tooltip = 'Large uncommitted diff finished without advisor review — click to open panel'
    } else if (snap.thread) {
      const latest = snap.thread.entries[snap.thread.entries.length - 1]
      if (latest?.source === 'auto-review' && latest.verdict === 'LGTM') {
        text = 'Advisor · Verified ✓'
        tone = 'success'
        tooltip = 'Last post-finish diff review passed (LGTM) — click to open panel'
      } else if (latest?.source === 'auto-review' && latest.verdict === 'CHANGES_REQUESTED') {
        text = 'Advisor · Fixes ready'
        tone = 'warning'
        tooltip = 'Post-finish diff review suggested changes — click to open panel'
      } else if (snap.settings.maxUsesPerTurn > 0 && snap.thread.turnMcpUses > 0) {
        text = `Advisor (${snap.thread.turnMcpUses}/${snap.settings.maxUsesPerTurn})`
        tone = 'neutral'
        tooltip = `${snap.thread.turnMcpUses} of ${snap.settings.maxUsesPerTurn} autonomous MCP calls used this turn`
      }
    }

    try {
      await orca.host.call('statusBar.update', {
        id: 'advisor-status',
        text,
        icon: 'layers',
        tone,
        tooltip
      })
    } catch {
      // ignore if host surface/mock doesn't expose status bar
    }
  }

  async function broadcastState(workspaceId?: string | null): Promise<WorkspaceSnapshot> {
    const snap = await buildSnapshot(workspaceId)
    orca.panels.post('advisor.state', snap)
    if (!workspaceId || !focusedWorkspaceId || workspaceId === focusedWorkspaceId) {
      await updateStatusBarForSnapshot(snap)
    }
    return snap
  }

  async function readTerminalTail(terminalId: string | null | undefined): Promise<string[]> {
    if (!terminalId) return []
    try {
      const res = await orca.host.call('terminal.read', { terminalId, maxLines: 120 })
      return res?.lines ?? []
    } catch {
      return []
    }
  }

  async function executeConsultation(params: {
    requestId?: string
    workspaceId?: string | null
    cwdHint?: string | null
    terminalId?: string | null
    question: string
    files?: string[]
    includeDiff?: boolean
    includeTerminal?: boolean
    source: ConsultSource
    agent: string | null
  }, externalSignal?: AbortSignal) {
    const settings = await refreshSettings()
    const ws = await resolveWorkspace(params.workspaceId, params.cwdHint)
    if (!ws.workspaceId) {
      throw new Error('No active workspace found in Orca.')
    }

    const requestHandle = engine.createRequestHandle({
      workspaceId: ws.workspaceId,
      source: params.source,
      agent: params.agent,
      question: params.question
    })
    if (params.requestId) {
      requestHandle.requestId = params.requestId
    }

    activeRequests.set(ws.workspaceId, requestHandle)
    lastErrors.delete(ws.workspaceId)
    await broadcastState(ws.workspaceId)

    const targetTerminalId = params.terminalId || ws.terminals[0]?.id || null
    const terminalLines = params.includeTerminal ? await readTerminalTail(targetTerminalId) : []

    try {
      const outcome = await engine.runConsultation(
        {
          requestId: requestHandle.requestId,
          workspaceId: ws.workspaceId,
          workspacePath: ws.path,
          branchHint: ws.branch,
          source: params.source,
          agent: params.agent,
          question: params.question,
          files: params.files,
          includeDiff: params.includeDiff ?? true,
          terminalLines,
          settings,
          storage: orca.storage,
          secrets: orca.secrets
        },
        externalSignal
      )

      if (params.source === 'unstick') {
        loopAlerts.delete(ws.workspaceId)
        if (targetTerminalId) loopTracker.clearTerminal(targetTerminalId)
      }
      if (outcome.verdict !== null) {
        pendingReviews.delete(ws.workspaceId)
      }

      return { ws, outcome, settings }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastErrors.set(ws.workspaceId, msg)
      orca.log(`[consult error] ${msg}`)
      throw err
    } finally {
      const cur = activeRequests.get(ws.workspaceId)
      if (cur?.requestId === requestHandle.requestId) {
        activeRequests.delete(ws.workspaceId)
      }
      await broadcastState(ws.workspaceId)
    }
  }

  async function handleMcpConsult(
    payload: IpcConsultPayload,
    signal: AbortSignal
  ): Promise<IpcConsultResult> {
    const question = typeof payload.question === 'string' ? payload.question.trim() : ''
    if (!question) {
      return { ok: false, advice: 'Invalid request: question must be a non-empty string.' }
    }

    const settings = await refreshSettings()
    if (!settings.enabled) {
      return {
        ok: true,
        advice:
          'Agent Advisor is currently paused in Orca. Continue executing independently, or ask the user to toggle Advisor ON in the Advisor panel.'
      }
    }

    const preferredWsId =
      typeof payload.workspaceId === 'string' && payload.workspaceId.trim()
        ? payload.workspaceId.trim()
        : null
    const cwdHint = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : null
    const ws = await resolveWorkspace(preferredWsId, cwdHint)

    if (!ws.workspaceId) {
      return {
        ok: false,
        advice: 'Could not determine an active Orca workspace for this advisor call.'
      }
    }

    const existingThread = await loadThread(orca.storage, ws.workspaceId, ws.branch)
    if (settings.maxUsesPerTurn > 0 && existingThread.turnMcpUses >= settings.maxUsesPerTurn) {
      return {
        ok: true,
        budgetExceeded: true,
        advice:
          `max_uses_exceeded (${existingThread.turnMcpUses}/${settings.maxUsesPerTurn} autonomous MCP calls used this turn). ` +
          `Proceed on your own with the codebase evidence you already gathered, or ask the user to reset the turn budget in the Advisor panel.`,
        meta: {
          workspaceId: ws.workspaceId,
          branch: existingThread.branch,
          backend: settings.backend,
          model: resolveEffectiveModel(settings),
          turnMcpUses: existingThread.turnMcpUses,
          maxUsesPerTurn: settings.maxUsesPerTurn,
          latencyMs: 0
        }
      }
    }

    const files = Array.isArray(payload.files)
      ? payload.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : undefined
    const includeDiff = typeof payload.includeDiff === 'boolean' ? payload.includeDiff : true
    const includeTerminal =
      typeof payload.includeTerminal === 'boolean' ? payload.includeTerminal : false
    const terminalId =
      typeof payload.terminalId === 'string' && payload.terminalId.trim()
        ? payload.terminalId.trim()
        : null
    const agent =
      typeof payload.agent === 'string' && payload.agent.trim() ? payload.agent.trim() : null

    try {
      const { outcome } = await executeConsultation(
        {
          workspaceId: ws.workspaceId,
          cwdHint,
          terminalId,
          question,
          files,
          includeDiff,
          includeTerminal,
          source: 'mcp',
          agent
        },
        signal
      )

      return {
        ok: true,
        advice: outcome.entry.advice,
        meta: {
          workspaceId: ws.workspaceId,
          branch: outcome.thread.branch,
          backend: outcome.entry.backend,
          model: outcome.entry.model,
          turnMcpUses: outcome.thread.turnMcpUses,
          maxUsesPerTurn: settings.maxUsesPerTurn,
          latencyMs: outcome.entry.latencyMs
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        advice: `Advisor consultation failed: ${msg}`
      }
    }
  }

  // Register panel RPC handlers
  disposables.push(
    orca.panels.handle('advisor.getState', async (input) => {
      return buildSnapshot(input?.workspaceId)
    }),

    orca.panels.handle('advisor.setEnabled', async (input) => {
      await orca.settings.set('enabled', Boolean(input.enabled))
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return { enabled: Boolean(input.enabled) }
    }),

    orca.panels.handle('advisor.setLevel', async (input) => {
      const level: AdvisorLevel =
        input.level === 'rare' || input.level === 'balanced' || input.level === 'frequent'
          ? input.level
          : 'balanced'
      const preset = ADVISOR_LEVEL_PRESETS[level]
      await orca.settings.set('advisorLevel', level)
      await orca.settings.set('maxUsesPerTurn', preset.maxUsesPerTurn)
      await orca.settings.set('loopThreshold', preset.loopThreshold)
      await orca.settings.set('postFinishReviewMode', preset.postFinishReviewMode)
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return { level }
    }),

    orca.panels.handle('advisor.selectProvider', async (input) => {
      const settings = await refreshSettings()
      const map = await loadModelsByBackend()
      map[modelPrefKey(settings.backend, settings.orcaAgent)] = settings.model

      const nextBackend = input.backend
      const nextAgent =
        nextBackend === 'orca-agent'
          ? input.orcaAgent?.trim() || settings.orcaAgent || 'codex'
          : settings.orcaAgent
      const nextModel = map[modelPrefKey(nextBackend, nextAgent)] ?? ''

      await saveModelsByBackend(map)
      await orca.settings.set('backend', nextBackend)
      if (nextBackend === 'orca-agent') {
        await orca.settings.set('orcaAgent', nextAgent)
      }
      await orca.settings.set('modelPreset', nextModel ? 'custom' : 'default')
      await orca.settings.set('model', nextModel)
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return { backend: nextBackend, orcaAgent: nextAgent, model: nextModel }
    }),

    orca.panels.handle('advisor.startConsult', async (input) => {
      const question = input?.question?.trim()
      if (!question) {
        const err = new Error('Question cannot be empty') as Error & { code: string }
        err.code = 'invalid_params'
        throw err
      }

      const ws = await resolveWorkspace(input?.workspaceId)
      if (!ws.workspaceId) {
        const err = new Error('No active workspace selected') as Error & { code: string }
        err.code = 'unavailable'
        throw err
      }

      const handle = engine.createRequestHandle({
        workspaceId: ws.workspaceId,
        source: input?.source ?? 'manual',
        agent: null,
        question
      })

      activeRequests.set(ws.workspaceId, handle)
      lastErrors.delete(ws.workspaceId)

      void executeConsultation({
        requestId: handle.requestId,
        workspaceId: ws.workspaceId,
        terminalId: input?.terminalId ?? null,
        question,
        files: input?.files,
        includeDiff: input?.includeDiff ?? true,
        includeTerminal: input?.includeTerminal ?? false,
        source: input?.source ?? 'manual',
        agent: null
      }).catch(() => undefined)

      return { requestId: handle.requestId }
    }),

    orca.panels.handle('advisor.cancelConsult', async (input) => {
      return { cancelled: engine.cancel(input.requestId) }
    }),

    orca.panels.handle('advisor.injectToTerminal', async (input) => {
      const prefix = input.prefix ?? 'Advisor guidance:\n'
      const text = `${prefix}${input.text.trim()}\n`
      return orca.host.call('terminal.sendText', {
        terminalId: input.terminalId,
        text,
        enter: true
      })
    }),

    orca.panels.handle('advisor.newThread', async (input) => {
      const ws = await resolveWorkspace(input?.workspaceId)
      if (ws.workspaceId) {
        await resetWorkspaceThread(orca.storage, ws.workspaceId, ws.branch)
        loopAlerts.delete(ws.workspaceId)
        pendingReviews.delete(ws.workspaceId)
        lastErrors.delete(ws.workspaceId)
        await broadcastState(ws.workspaceId)
      }
      return { ok: true as const }
    }),

    orca.panels.handle('advisor.resetBudget', async (input) => {
      const ws = await resolveWorkspace(input?.workspaceId)
      if (ws.workspaceId) {
        await resetTurnBudget(orca.storage, ws.workspaceId, ws.branch)
        await broadcastState(ws.workspaceId)
      }
      return { ok: true as const }
    }),

    orca.panels.handle('advisor.dismissAlerts', async (input) => {
      const ws = await resolveWorkspace(input?.workspaceId)
      if (ws.workspaceId) {
        loopAlerts.delete(ws.workspaceId)
        pendingReviews.delete(ws.workspaceId)
        lastErrors.delete(ws.workspaceId)
        for (const t of ws.terminals) {
          loopTracker.clearTerminal(t.id)
        }
        await broadcastState(ws.workspaceId)
      }
      return { ok: true as const }
    }),

    orca.panels.handle('advisor.saveApiKey', async (input) => {
      try {
        const prot = await orca.host.call('secrets.protection', {})
        if (prot.status === 'unavailable') {
          return {
            ok: false,
            error: 'OS keyring is unavailable on this machine; cannot store secrets safely.'
          }
        }
      } catch {
        // mockHost may omit secrets.protection; allow secrets.set to decide
      }

      const trimmed = input.apiKey.trim()
      if (!trimmed) {
        return { ok: false, error: 'API key cannot be empty.' }
      }
      await orca.secrets.set(secretKeyForBackend(input.backend), trimmed)
      clearModelCatalogCache()
      return { ok: true }
    }),

    orca.panels.handle('advisor.deleteApiKey', async (input) => {
      await orca.secrets.delete(secretKeyForBackend(input.backend))
      clearModelCatalogCache()
      return { ok: true as const }
    }),

    orca.panels.handle('advisor.testConnection', async (input) => {
      const [settings, ws] = await Promise.all([refreshSettings(), resolveWorkspace()])
      return testProviderConnection({
        settings,
        secrets: orca.secrets,
        backend: input?.backend,
        orcaAgent: input?.orcaAgent,
        model: input?.model,
        cwd: ws.path
      })
    }),

    orca.panels.handle('advisor.listModels', async (input) => {
      const settings = await refreshSettings()
      const backend = input?.backend ?? settings.backend
      const orcaAgent = input?.orcaAgent ?? settings.orcaAgent
      return listModelsForBackend({
        backend,
        orcaAgent,
        settings,
        secrets: orca.secrets,
        forceRefresh: Boolean(input?.forceRefresh)
      })
    }),

    orca.panels.handle('advisor.selectBackend', async (input) => {
      const settings = await refreshSettings()
      const map = await loadModelsByBackend()
      map[modelPrefKey(settings.backend, settings.orcaAgent)] = settings.model
      const nextModel = map[modelPrefKey(input.backend, settings.orcaAgent)] ?? ''
      await saveModelsByBackend(map)
      await orca.settings.set('backend', input.backend)
      await orca.settings.set('modelPreset', nextModel ? 'custom' : 'default')
      await orca.settings.set('model', nextModel)
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return { backend: input.backend, model: nextModel }
    }),

    orca.panels.handle('advisor.selectOrcaAgent', async (input) => {
      const settings = await refreshSettings()
      const map = await loadModelsByBackend()
      map[modelPrefKey('orca-agent', settings.orcaAgent)] = settings.model
      const nextModel = map[modelPrefKey('orca-agent', input.orcaAgent)] ?? ''
      await saveModelsByBackend(map)
      await orca.settings.set('orcaAgent', input.orcaAgent)
      await orca.settings.set('modelPreset', nextModel ? 'custom' : 'default')
      await orca.settings.set('model', nextModel)
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return { orcaAgent: input.orcaAgent, model: nextModel }
    }),

    orca.panels.handle('advisor.selectModel', async (input) => {
      const settings = await refreshSettings()
      const map = await loadModelsByBackend()
      const trimmed = input.model.trim()
      const agentKey = input.orcaAgent ?? settings.orcaAgent
      map[modelPrefKey(input.backend, agentKey)] = trimmed
      await saveModelsByBackend(map)
      if (settings.backend === input.backend) {
        await orca.settings.set('modelPreset', trimmed ? 'custom' : 'default')
        await orca.settings.set('model', trimmed)
        await refreshSettings()
      }
      await broadcastState(focusedWorkspaceId)
      return { ok: true as const }
    }),

    orca.panels.handle('advisor.getSetupStatus', async (input) => {
      const ws = await resolveWorkspace(input?.workspaceId)
      let protection: 'os-keyring' | 'unavailable' = 'os-keyring'
      try {
        const res = await orca.host.call('secrets.protection', {})
        protection = res.status
      } catch {
        protection = 'os-keyring'
      }

      return getSetupStatus({
        workspacePath: ws.path,
        secrets: orca.secrets,
        secretsProtection: protection,
        ipcRunning: Boolean(ipcHandle?.running),
        ipcPort: ipcHandle?.port ?? null
      })
    }),

    orca.panels.handle('advisor.installMcp', async (input) => {
      const ws = await resolveWorkspace(input.workspaceId)
      return installMcpTarget(input.target, ws.path)
    }),

    orca.panels.handle('advisor.installSkill', async () => {
      return installGlobalSkill()
    })
  )

  // Register commands
  disposables.push(
    orca.commands.register('advisor.open', async () => {
      // Opens the Advisor sidebar panel directly without popping up a command output modal.
      orca.log('command advisor.open invoked')
      if (process.env.AGENT_ADVISOR_DISABLE_IPC !== '1') {
        const res = await openAdvisorPanel('local.agent-advisor', 'advisor-panel', (m) =>
          orca.log(m)
        ).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }))
        if (!res.ok) {
          void orca.host
            .call('notifications.show', {
              title: 'Agent Advisor',
              body: res.error || 'Could not open Advisor panel. Open a workspace first.'
            })
            .catch(() => undefined)
        }
      }
      return undefined
    }),

    orca.commands.register('advisor.consult', async (_args, context) => {
      try {
        const { outcome } = await executeConsultation(
          {
            question:
              'Review current workspace progress, spot any blind spots or edge cases, and suggest the cleanest next step.',
            includeDiff: true,
            includeTerminal: true,
            source: 'command',
            agent: null
          },
          context.signal
        )
        return outcome.entry.advice
      } catch (err) {
        return `Advisor error: ${err instanceof Error ? err.message : String(err)}`
      }
    }),

    orca.commands.register('advisor.reviewDiff', async (_args, context) => {
      try {
        const { outcome } = await executeConsultation(
          {
            question:
              'Review the current git diff carefully for bugs, regressions, security risks, and edge cases. Start with VERDICT: LGTM if clean or VERDICT: CHANGES_REQUESTED with numbered fixes.',
            includeDiff: true,
            includeTerminal: false,
            source: 'command',
            agent: null
          },
          context.signal
        )
        return outcome.entry.advice
      } catch (err) {
        return `Advisor review error: ${err instanceof Error ? err.message : String(err)}`
      }
    }),

    orca.commands.register('advisor.newThread', async () => {
      const ws = await resolveWorkspace()
      if (!ws.workspaceId) return 'No active workspace.'
      await resetWorkspaceThread(orca.storage, ws.workspaceId, ws.branch)
      loopAlerts.delete(ws.workspaceId)
      pendingReviews.delete(ws.workspaceId)
      lastErrors.delete(ws.workspaceId)
      await broadcastState(ws.workspaceId)
      return `Started a fresh advisor thread for ${ws.displayName ?? ws.workspaceId}.`
    }),

    orca.commands.register('advisor.resetBudget', async () => {
      const ws = await resolveWorkspace()
      if (!ws.workspaceId) return 'No active workspace.'
      await resetTurnBudget(orca.storage, ws.workspaceId, ws.branch)
      await broadcastState(ws.workspaceId)
      return `Reset autonomous advisor turn budget for ${ws.displayName ?? ws.workspaceId}.`
    }),

    orca.commands.register('advisor.toggleLoopDetector', async () => {
      const settings = await refreshSettings()
      const nextValue = !settings.loopDetectionEnabled
      await orca.settings.set('loopDetectionEnabled', nextValue)
      await refreshSettings()
      await broadcastState(focusedWorkspaceId)
      return `Loop detection ${nextValue ? 'enabled' : 'disabled'}.`
    })
  )

  // Settings change listener keeps cachedSettings warm for fast synchronous hooks
  disposables.push(
    orca.settings.onDidChange(() => {
      void refreshSettings().then(() => broadcastState(focusedWorkspaceId)).catch(() => undefined)
    })
  )

  // Subscribe to declared Orca events
  disposables.push(
    orca.events.on('workspace.changed', async (payload) => {
      focusedWorkspaceId = payload.context?.workspaceId ?? null
      await broadcastState(focusedWorkspaceId)
    }),

    orca.events.on('workspace.removed', async (payload) => {
      const ids = [payload.workspaceId, payload.workspaceListId].filter(
        (id): id is string => Boolean(id)
      )
      for (const id of ids) {
        loopAlerts.delete(id)
        pendingReviews.delete(id)
        lastErrors.delete(id)
        await deleteWorkspaceThread(orca.storage, id)
      }
      await broadcastState(focusedWorkspaceId)
    }),

    orca.events.on('agent.status.changed', async (ev) => {
      const transition = turnTracker.onStatusChanged(ev)
      const workspaceId = ev.workspaceListId ?? ev.workspaceId
      if (!workspaceId) return

      if (transition === 'turn_started') {
        const ws = await resolveWorkspace(workspaceId)
        await resetTurnBudget(orca.storage, workspaceId, ws.branch)
        pendingReviews.delete(workspaceId)
        await broadcastState(workspaceId)
        return
      }

      if (transition !== 'turn_finished') return

      const settings = await refreshSettings()
      if (!settings.enabled || settings.postFinishReviewMode === 'off') return

      const ws = await resolveWorkspace(workspaceId)
      if (!ws.path) return

      const thread = await loadThread(orca.storage, workspaceId, ws.branch)
      if (thread.turnMcpUses > 0) return
      if (activeRequests.has(workspaceId)) return

      const diffStats = await computeDiffStats(ws.path, settings.maxDiffChars)
      if (diffStats.changedLines < settings.minDiffLinesForReview) return
      if (thread.reviewedDiffHashes.includes(diffStats.diffHash)) return

      const terminalId = ev.terminalId ?? ws.terminals[0]?.id ?? ''

      if (settings.postFinishReviewMode === 'suggest') {
        const alert: PendingReviewAlert = {
          workspaceId,
          terminalId,
          diffHash: diffStats.diffHash,
          added: diffStats.added,
          removed: diffStats.removed,
          files: diffStats.files,
          at: Date.now()
        }
        pendingReviews.set(workspaceId, alert)
        await broadcastState(workspaceId)

        if (settings.notifyOnAlerts) {
          void orca.host
            .call('notifications.show', {
              title: 'Advisor: Unreviewed Diff Ready',
              body: `${ws.displayName ?? workspaceId}: +${diffStats.added}/-${diffStats.removed} across ${diffStats.files} file(s).`
            })
            .catch(() => undefined)
        }
        return
      }

      // Automatic background post-finish review (anti-loop: mark diffHash BEFORE running)
      await markDiffReviewed(orca.storage, workspaceId, ws.branch, diffStats.diffHash)

      try {
        const { outcome } = await executeConsultation({
          workspaceId,
          terminalId: terminalId || null,
          question:
            'The agent just finished a multi-line change without consulting the advisor. Review the git diff for bugs, regressions, edge cases, and missing checks. Begin with VERDICT: LGTM or VERDICT: CHANGES_REQUESTED.',
          includeDiff: true,
          includeTerminal: false,
          source: 'auto-review',
          agent: null
        })

        if (outcome.verdict === 'LGTM') {
          if (settings.notifyOnAlerts) {
            void orca.host
              .call('notifications.show', {
                title: 'Advisor: Diff Verified (LGTM)',
                body: `${ws.displayName ?? workspaceId} passed automated review.`
              })
              .catch(() => undefined)
          }
          return
        }

        if (settings.autoInjectReviewFixes && terminalId) {
          await orca.host.call('terminal.sendText', {
            terminalId,
            text: `Advisor post-finish review found issues to fix before wrapping up:\n${outcome.entry.advice}\nPlease address these items and re-verify.`,
            enter: true
          })
        } else if (settings.notifyOnAlerts) {
          void orca.host
            .call('notifications.show', {
              title: 'Advisor: Review Found Issues',
              body: `Check the Advisor panel for suggested fixes in ${ws.displayName ?? workspaceId}.`
            })
            .catch(() => undefined)
        }
      } catch (err) {
        orca.log(`[auto-review error] ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  )

  // Register declared hooks (never perform slow async I/O before deciding!)
  disposables.push(
    orca.hooks.on('agent.launch.before', (event, next) => {
      const discoveryFile = ipcHandle?.discoveryFile ?? getDiscoveryFilePath()
      return next({
        ...event,
        env: {
          ...event.env,
          AGENT_ADVISOR_WORKSPACE_ID: event.workspaceId ?? '',
          AGENT_ADVISOR_TERMINAL_ID: event.terminalId ?? '',
          AGENT_ADVISOR_AGENT: event.agent,
          AGENT_ADVISOR_IPC_FILE: discoveryFile
        }
      })
    }),

    orca.hooks.on('agent.prompt.before', (event, next) => {
      if (!cachedSettings.enabled || !cachedSettings.injectPromptGuidance) {
        return
      }
      if (/\badvisor\b/i.test(event.prompt)) {
        return
      }
      const guidance =
        '\n\n[Advisor note: The read-only `advisor` MCP tool is available for architectural sanity-checks before large edits, when stuck on recurring failures, and for a final diff review before wrapping up.]'
      return next({
        ...event,
        prompt: `${event.prompt}${guidance}`
      })
    }),

    orca.hooks.on('agent.tool.after', async (event) => {
      if (!cachedSettings.enabled || !cachedSettings.loopDetectionEnabled) return
      const { alert, newlyTriggered } = loopTracker.recordToolAfter(
        event,
        cachedSettings.loopThreshold
      )
      if (!alert) return

      const workspaceId = event.workspaceId ?? focusedWorkspaceId
      if (workspaceId) {
        loopAlerts.set(workspaceId, alert)
        if (newlyTriggered) {
          await recordLoopStat(orca.storage).catch(() => undefined)
        }
        await broadcastState(workspaceId)
      }

      if (newlyTriggered && cachedSettings.notifyOnAlerts) {
        void orca.host
          .call('notifications.show', {
            title: `Advisor: Loop Detected (${alert.count}x)`,
            body: `Agent "${alert.agent}" repeated ${alert.tool} ${alert.count} times. Open Advisor to get unstuck.`
          })
          .catch(() => undefined)
      }
    })
  )

  // Prime settings and optionally start IPC server
  await refreshSettings()

  const disableIpc =
    process.env.AGENT_ADVISOR_DISABLE_IPC === '1' ||
    (Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.AGENT_ADVISOR_IPC_FILE)

  if (!disableIpc) {
    ipcHandle = await startIpcServer({
      onConsult: handleMcpConsult,
      onLog: (m) => orca.log(m)
    })
  }

  activeDeactivate = async () => {
    engine.cancelAll()
    for (const d of disposables) {
      d.dispose()
    }
    if (ipcHandle) {
      await ipcHandle.stop()
      ipcHandle = null
    }
  }

  orca.log(
    `Agent Advisor worker ready (ipc=${ipcHandle?.port ?? 'disabled'}, execPath=${process.execPath})`
  )
  await broadcastState(focusedWorkspaceId)

  // Auto-connect installed local agents & install /advisor skill in the background (zero-config)
  if (!disableIpc && cachedSettings.autoConnectAgents) {
    void ensureAutoSetup((m) => orca.log(m))
      .then(async (summary) => {
        autoSetupSummary = summary
        orca.log(
          `Auto-setup ready: agents=[${summary.connectedAgents.join(', ')}], skill=${summary.skillInstalled}`
        )
        await broadcastState(focusedWorkspaceId)
      })
      .catch((err) => {
        orca.log(`Auto-setup error: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}
