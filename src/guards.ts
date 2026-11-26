import type { JsonValue } from 'orca/host'
import type { PluginEvents, PluginHooks } from 'orca/worker'
import type { LoopAlert, ReviewVerdict } from './types'

const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'glob',
  'grep',
  'grep_search',
  'find_by_name',
  'ls',
  'list_dir',
  'advisor',
  'get_file',
  'search'
])

function stripMcpToolPrefix(toolName: string): string {
  const lower = toolName.trim().toLowerCase()
  const parts = lower.split('__')
  return parts.length >= 3 ? parts[parts.length - 1] : lower
}

export function isReadOnlyToolName(toolName: string): boolean {
  const base = stripMcpToolPrefix(toolName)
  return READ_ONLY_TOOL_NAMES.has(base)
}

export function stableCompactInput(input: JsonValue | undefined): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input.trim().slice(0, 140)
  if (typeof input !== 'object') return String(input)
  try {
    if (Array.isArray(input)) {
      return JSON.stringify(input).slice(0, 140)
    }
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(input).sort()) {
      sorted[k] = input[k]
    }
    return JSON.stringify(sorted).slice(0, 140)
  } catch {
    return '[unserializable]'
  }
}

export function outputLooksLikeError(output: JsonValue | undefined): boolean {
  if (output === null || output === undefined) return false
  if (typeof output === 'object' && !Array.isArray(output)) {
    if (output.isError === true || output.is_error === true) return true
    if (typeof output.exitCode === 'number' && output.exitCode !== 0) return true
    if (typeof output.exit_code === 'number' && output.exit_code !== 0) return true
    if (typeof output.error === 'string' && output.error.trim().length > 0) return true
  }
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return /\b(command failed|exit code [1-9]|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError|AssertionError|Traceback \(most recent call last\)|ERR!|fatal:|panic:)\b/i.test(
    text.slice(0, 2000)
  )
}

type StreakEntry = {
  sig: string
  tool: string
  count: number
  lastTriggeredAtCount: number
  lastInputSummary: string
}

export class LoopTracker {
  private readonly streaks = new Map<string, StreakEntry>()

  recordToolAfter(
    ev: PluginHooks['agent.tool.after']['event'],
    threshold: number
  ): { alert: LoopAlert | null; newlyTriggered: boolean } {
    const key = ev.terminalId ?? ev.workspaceId ?? 'global'
    const summary = stableCompactInput(ev.input)
    const hasError = outputLooksLikeError(ev.output)

    if (isReadOnlyToolName(ev.tool) && !hasError) {
      return { alert: null, newlyTriggered: false }
    }

    const sig = `${ev.tool.trim().toLowerCase()}:${summary}`
    const prev = this.streaks.get(key)

    let next: StreakEntry
    if (prev && prev.sig === sig) {
      next = {
        ...prev,
        count: prev.count + 1,
        lastInputSummary: summary
      }
    } else if (prev && hasError && prev.tool.toLowerCase() === ev.tool.trim().toLowerCase()) {
      // Consecutive errors on the same tool even with slightly varied command flags/inputs
      next = {
        sig,
        tool: ev.tool,
        count: prev.count + 1,
        lastTriggeredAtCount: prev.lastTriggeredAtCount,
        lastInputSummary: summary
      }
    } else {
      next = {
        sig,
        tool: ev.tool,
        count: 1,
        lastTriggeredAtCount: 0,
        lastInputSummary: summary
      }
    }

    this.streaks.set(key, next)

    if (next.count < threshold) {
      return { alert: null, newlyTriggered: false }
    }

    const newlyTriggered = next.count > next.lastTriggeredAtCount
    next.lastTriggeredAtCount = next.count

    return {
      newlyTriggered,
      alert: {
        terminalId: key,
        agent: ev.agent,
        tool: ev.tool,
        count: next.count,
        lastInputSummary: next.lastInputSummary,
        at: Date.now()
      }
    }
  }

  clearTerminal(key: string): void {
    this.streaks.delete(key)
  }

  clearAll(): void {
    this.streaks.clear()
  }
}

export type TurnTransition = 'turn_started' | 'turn_finished' | 'none'

export class TurnTracker {
  private readonly wasWorking = new Map<string, boolean>()

  onStatusChanged(ev: PluginEvents['agent.status.changed']): TurnTransition {
    const key = ev.terminalId ?? ev.paneKey
    const prevWorking = this.wasWorking.get(key) ?? false

    if (ev.state === 'working') {
      this.wasWorking.set(key, true)
      return prevWorking ? 'none' : 'turn_started'
    }

    if (prevWorking && (ev.state === 'done' || ev.state === 'waiting')) {
      this.wasWorking.set(key, false)
      return 'turn_finished'
    }

    return 'none'
  }

  clearTerminal(key: string): void {
    this.wasWorking.delete(key)
  }
}

export function parseAdvisorVerdict(advice: string): ReviewVerdict {
  const lines = advice
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 4)

  for (const line of lines) {
    const cleaned = line.replace(/^[*_#`>\s-]+/, '')
    if (/^(?:VERDICT\s*:\s*)?LGTM\b/i.test(cleaned)) {
      return 'LGTM'
    }
    if (/^(?:VERDICT\s*:\s*)?CHANGES[_\s-]*REQUESTED\b/i.test(cleaned)) {
      return 'CHANGES_REQUESTED'
    }
  }

  return 'CHANGES_REQUESTED'
}
