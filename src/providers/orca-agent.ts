import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OrcaInstalledAgent } from '../types'
import { resolveExecutable, spawnWithStdin, type ResolvedExecutable } from './cli-exec'
import type { ProviderRequest, ProviderResponse } from './types'

const MAX_ORCA_PROMPT_CHARS = 18_000
const POLL_INTERVAL_MS = 1_500
const LAUNCH_TIMEOUT_MS = 30_000
const TOTAL_WAIT_TIMEOUT_MS = 180_000

let cachedInstalledAgents: { at: number; agents: OrcaInstalledAgent[] } | null = null
let cachedOrcaExec: ResolvedExecutable | null = null

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function resolveOrcaExecutable(): Promise<ResolvedExecutable | null> {
  if (cachedOrcaExec && (await exists(cachedOrcaExec.command))) {
    return cachedOrcaExec
  }

  const execDir = path.dirname(process.execPath)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const binName = process.platform === 'win32' ? 'orca.exe' : 'orca'

  const candidates: string[] = []
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'bin', binName))
  }
  candidates.push(
    path.join(execDir, 'resources', 'bin', binName),
    path.join(execDir, '..', 'Resources', 'bin', binName),
    path.join(execDir, 'bin', binName)
  )

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Orca.app/Contents/Resources/bin/orca', '/usr/local/bin/orca')
  } else {
    candidates.push('/usr/local/bin/orca', '/usr/bin/orca')
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      cachedOrcaExec = { command: candidate, prefixArgs: [], displayPath: candidate }
      return cachedOrcaExec
    }
  }

  const fromPath = await resolveExecutable('orca')
  if (fromPath) {
    cachedOrcaExec = fromPath
    return fromPath
  }

  return null
}

async function runOrcaJson(
  args: string[],
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<{
  ok: boolean
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
  execPath?: string
}> {
  const execSpec = await resolveOrcaExecutable()
  if (!execSpec) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Orca CLI (\`orca\`) not found on PATH or beside ${process.execPath}.`
      }
    }
  }

  const res = await spawnWithStdin(execSpec, [...args, '--json'], '', {
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? 15_000,
    stripElectronRunAsNode: true
  })

  if (res.aborted) {
    return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, execPath: execSpec.displayPath }
  }
  if (res.timedOut) {
    return {
      ok: false,
      error: { code: 'timeout', message: 'Orca CLI command timed out.' },
      execPath: execSpec.displayPath
    }
  }

  const raw = res.stdout.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        ok?: boolean
        result?: Record<string, unknown>
        error?: { code?: string; message?: string }
      }
      return {
        ok: Boolean(parsed.ok),
        result: parsed.result,
        error: parsed.error,
        execPath: execSpec.displayPath
      }
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    execPath: execSpec.displayPath,
    error: {
      code: 'cli_error',
      message: res.stderr.trim() || raw || `orca exited with code ${res.code}`
    }
  }
}

export async function listInstalledOrcaAgents(
  forceRefresh = false,
  log?: (msg: string) => void
): Promise<OrcaInstalledAgent[]> {
  if (!forceRefresh && cachedInstalledAgents && Date.now() - cachedInstalledAgents.at < 60_000) {
    return cachedInstalledAgents.agents
  }

  const res = await runOrcaJson(['agent', 'installed'], { timeoutMs: 8_000 })
  if (res.ok && Array.isArray(res.result?.agents)) {
    const agents = (res.result.agents as unknown[])
      .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
      .map((a) => ({
        id: String(a.id ?? '').trim(),
        name: String(a.name ?? a.id ?? '').trim(),
        default: Boolean(a.default)
      }))
      .filter((a) => a.id.length > 0)

    cachedInstalledAgents = { at: Date.now(), agents }
    return agents
  }

  if (!res.ok) {
    log?.(`listInstalledOrcaAgents failed (${res.error?.code ?? 'error'}): ${res.error?.message ?? 'unknown'}`)
  }

  return cachedInstalledAgents?.agents ?? []
}

export async function openAdvisorPanel(
  pluginKey = 'local.agent-advisor',
  panelId = 'advisor-panel',
  log?: (msg: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const res = await runOrcaJson(['plugin', 'open', pluginKey, '--panel', panelId], {
    timeoutMs: 8_000
  })
  if (!res.ok) {
    const errText = `${res.error?.code ?? 'error'}: ${res.error?.message ?? 'unknown'} (bin: ${res.execPath ?? 'none'})`
    log?.(`openAdvisorPanel failed -> ${errText}`)
    return { ok: false, error: res.error?.message || errText }
  }
  log?.(`openAdvisorPanel succeeded -> ${pluginKey}/${panelId}`)
  return { ok: true }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Consultation cancelled.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Consultation cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function buildOrcaAgentPrompt(req: ProviderRequest): string {
  const parts: string[] = [
    '[READ-ONLY ADVISOR REQUEST — Do NOT edit files, do NOT run mutating commands, do NOT invoke the `advisor` MCP tool.]',
    req.systemPrompt
  ]

  if (req.history.length > 0) {
    const recent = req.history.slice(-4)
    const hist = recent
      .map((m) => `[${m.role === 'user' ? 'Executor' : 'Advisor'}]\n${m.content.slice(0, 1500)}`)
      .join('\n---\n')
    parts.push(`<prior_thread>\n${hist}\n</prior_thread>`)
  }

  parts.push(req.userMessage)
  const full = parts.join('\n\n')
  if (full.length <= MAX_ORCA_PROMPT_CHARS) return full
  return `${full.slice(0, MAX_ORCA_PROMPT_CHARS)}\n\n... [context clipped to fit Orca launch prompt budget]`
}

function extractSessionId(result: Record<string, unknown> | undefined): string | null {
  if (!result) return null
  const direct = result.orcaSessionId ?? result.sessionId
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  for (const key of ['session', 'outcome', 'agent', 'terminal']) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const rec = nested as Record<string, unknown>
      const id = rec.orcaSessionId ?? rec.sessionId
      if (typeof id === 'string' && id.trim()) return id.trim()
    }
  }
  return null
}

function extractAssistantReply(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const item = entries[i]
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (rec.kind === 'message' && rec.role === 'assistant' && typeof rec.text === 'string') {
      const trimmed = rec.text.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

export async function runOrcaAgent(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const agentId = req.orcaAgent?.trim() || 'codex'
  const promptText = buildOrcaAgentPrompt(req)

  const launchArgs = [
    'agent',
    'launch',
    '--agent',
    agentId,
    '--worktree',
    req.cwd ? `path:${req.cwd}` : 'active'
  ]

  const trimmedModel = req.model.trim()
  if (trimmedModel) {
    launchArgs.push('--model', trimmedModel)
    if (req.reasoningEffort && req.reasoningEffort !== 'default') {
      launchArgs.push('--effort', req.reasoningEffort)
    }
  }
  launchArgs.push('--prompt', promptText)

  const launchRes = await runOrcaJson(launchArgs, {
    signal,
    timeoutMs: LAUNCH_TIMEOUT_MS
  })

  if (!launchRes.ok) {
    throw new Error(
      launchRes.error?.message || `Failed to launch Orca agent "${agentId}".`
    )
  }

  const sessionId = extractSessionId(launchRes.result)
  if (!sessionId) {
    throw new Error(
      `Orca launched "${agentId}" without returning an orcaSessionId. Check that a workspace is active in Orca.`
    )
  }

  const normalizedId = sessionId.startsWith('orca_session_id:')
    ? sessionId
    : `orca_session_id:${sessionId}`
  const deadline = Date.now() + TOTAL_WAIT_TIMEOUT_MS

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal)

    const readRes = await runOrcaJson(['agent', 'read', normalizedId, '--limit', '12'], {
      signal,
      timeoutMs: 10_000
    })

    if (readRes.ok && readRes.result) {
      const state = typeof readRes.result.state === 'string' ? readRes.result.state : ''
      const reply = extractAssistantReply(readRes.result.entries)
      if (reply && (state === 'done' || state === 'waiting' || state === '')) {
        return {
          advice: reply,
          model: trimmedModel || `orca:${agentId}`,
          usage: null,
          orcaSessionId: sessionId
        }
      }
    }

    const showRes = await runOrcaJson(['agent', 'show', normalizedId], {
      signal,
      timeoutMs: 8_000
    })
    if (showRes.ok && Array.isArray(showRes.result?.places) && showRes.result.places.length > 0) {
      const place = showRes.result.places[0] as Record<string, unknown>
      const placeState = typeof place.state === 'string' ? place.state : ''
      const lastMsg =
        typeof place.lastAssistantMessage === 'string' ? place.lastAssistantMessage.trim() : ''
      if ((placeState === 'done' || placeState === 'waiting') && lastMsg) {
        const finalRead = await runOrcaJson(['agent', 'read', normalizedId, '--limit', '12'], {
          signal,
          timeoutMs: 10_000
        })
        const fullReply = extractAssistantReply(finalRead.result?.entries) || lastMsg
        return {
          advice: fullReply,
          model: trimmedModel || `orca:${agentId}`,
          usage: null,
          orcaSessionId: sessionId
        }
      }
    }
  }

  throw new Error(`Orca agent "${agentId}" did not finish within ${Math.round(TOTAL_WAIT_TIMEOUT_MS / 1000)}s.`)
}
