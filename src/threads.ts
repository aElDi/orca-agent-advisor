import type { JsonValue, StorageApi } from 'orca/host'
import type { GlobalStats, ThreadEntry, WorkspaceThread } from './types'

const MAX_STORED_ENTRIES_PER_WORKSPACE = 40
const MAX_STORED_DIFF_HASHES = 20

export const STATS_STORAGE_KEY = 'stats:global'

export function threadStorageKey(workspaceId: string): string {
  return `thread:${workspaceId}`
}

export function emptyStats(): GlobalStats {
  return {
    totalCalls: 0,
    mcpCalls: 0,
    manualCalls: 0,
    autoReviewCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    loopAlerts: 0
  }
}

export function createEmptyThread(workspaceId: string, branch: string | null): WorkspaceThread {
  return {
    workspaceId,
    branch,
    updatedAt: Date.now(),
    entries: [],
    turnMcpUses: 0,
    reviewedDiffHashes: []
  }
}

function asNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : 0
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function normalizeThread(
  raw: JsonValue | null,
  workspaceId: string,
  currentBranch: string | null
): WorkspaceThread {
  if (!isObject(raw)) {
    return createEmptyThread(workspaceId, currentBranch)
  }

  const storedBranch = typeof raw.branch === 'string' ? raw.branch : null
  if (storedBranch && currentBranch && storedBranch !== currentBranch) {
    return createEmptyThread(workspaceId, currentBranch)
  }

  const entries = Array.isArray(raw.entries)
    ? (raw.entries.filter((e) => isObject(e) && typeof e.id === 'string') as ThreadEntry[])
    : []

  const reviewedDiffHashes = Array.isArray(raw.reviewedDiffHashes)
    ? raw.reviewedDiffHashes.filter((h): h is string => typeof h === 'string')
    : []

  return {
    workspaceId,
    branch: currentBranch ?? storedBranch,
    updatedAt: asNumber(raw.updatedAt) || Date.now(),
    entries: entries.slice(-MAX_STORED_ENTRIES_PER_WORKSPACE),
    turnMcpUses: asNumber(raw.turnMcpUses),
    reviewedDiffHashes: reviewedDiffHashes.slice(-MAX_STORED_DIFF_HASHES)
  }
}

export function normalizeStats(raw: JsonValue | null): GlobalStats {
  if (!isObject(raw)) return emptyStats()
  return {
    totalCalls: asNumber(raw.totalCalls),
    mcpCalls: asNumber(raw.mcpCalls),
    manualCalls: asNumber(raw.manualCalls),
    autoReviewCalls: asNumber(raw.autoReviewCalls),
    totalInputTokens: asNumber(raw.totalInputTokens),
    totalOutputTokens: asNumber(raw.totalOutputTokens),
    totalCacheReadTokens: asNumber(raw.totalCacheReadTokens),
    totalCostUsd: asNumber(raw.totalCostUsd),
    loopAlerts: asNumber(raw.loopAlerts)
  }
}

export async function loadThread(
  storage: StorageApi,
  workspaceId: string,
  currentBranch: string | null
): Promise<WorkspaceThread> {
  const raw = await storage.get(threadStorageKey(workspaceId))
  const normalized = normalizeThread(raw, workspaceId, currentBranch)
  if (
    isObject(raw) &&
    typeof raw.branch === 'string' &&
    currentBranch &&
    raw.branch !== currentBranch
  ) {
    await storage.set(threadStorageKey(workspaceId), normalized as unknown as JsonValue)
  }
  return normalized
}

export async function saveThread(storage: StorageApi, thread: WorkspaceThread): Promise<void> {
  const bounded: WorkspaceThread = {
    ...thread,
    updatedAt: Date.now(),
    entries: thread.entries.slice(-MAX_STORED_ENTRIES_PER_WORKSPACE),
    reviewedDiffHashes: thread.reviewedDiffHashes.slice(-MAX_STORED_DIFF_HASHES)
  }
  await storage.set(threadStorageKey(thread.workspaceId), bounded as unknown as JsonValue)
}

export async function loadStats(storage: StorageApi): Promise<GlobalStats> {
  const raw = await storage.get(STATS_STORAGE_KEY)
  return normalizeStats(raw)
}

export async function saveStats(storage: StorageApi, stats: GlobalStats): Promise<void> {
  await storage.set(STATS_STORAGE_KEY, stats as unknown as JsonValue)
}

export async function appendThreadEntry(
  storage: StorageApi,
  workspaceId: string,
  branch: string | null,
  entry: ThreadEntry,
  options?: { incrementMcpUse?: boolean; reviewedDiffHash?: string }
): Promise<{ thread: WorkspaceThread; stats: GlobalStats }> {
  const thread = await loadThread(storage, workspaceId, branch)
  thread.branch = branch ?? thread.branch
  thread.entries = [...thread.entries, entry].slice(-MAX_STORED_ENTRIES_PER_WORKSPACE)
  if (options?.incrementMcpUse) {
    thread.turnMcpUses += 1
  }
  if (
    options?.reviewedDiffHash &&
    !thread.reviewedDiffHashes.includes(options.reviewedDiffHash)
  ) {
    thread.reviewedDiffHashes = [...thread.reviewedDiffHashes, options.reviewedDiffHash].slice(
      -MAX_STORED_DIFF_HASHES
    )
  }
  await saveThread(storage, thread)

  const stats = await loadStats(storage)
  if (!entry.error) {
    stats.totalCalls += 1
    if (entry.source === 'mcp') stats.mcpCalls += 1
    else if (entry.source === 'auto-review') stats.autoReviewCalls += 1
    else stats.manualCalls += 1
    if (entry.usage) {
      stats.totalInputTokens += entry.usage.inputTokens ?? 0
      stats.totalOutputTokens += entry.usage.outputTokens ?? 0
      stats.totalCacheReadTokens += entry.usage.cacheReadTokens ?? 0
      stats.totalCostUsd += entry.usage.costUsd ?? 0
    }
    await saveStats(storage, stats)
  }

  return { thread, stats }
}

export async function recordLoopStat(storage: StorageApi): Promise<GlobalStats> {
  const stats = await loadStats(storage)
  stats.loopAlerts += 1
  await saveStats(storage, stats)
  return stats
}

export async function resetWorkspaceThread(
  storage: StorageApi,
  workspaceId: string,
  branch: string | null
): Promise<WorkspaceThread> {
  const fresh = createEmptyThread(workspaceId, branch)
  await saveThread(storage, fresh)
  return fresh
}

export async function resetTurnBudget(
  storage: StorageApi,
  workspaceId: string,
  branch: string | null
): Promise<WorkspaceThread> {
  const thread = await loadThread(storage, workspaceId, branch)
  thread.turnMcpUses = 0
  await saveThread(storage, thread)
  return thread
}

export async function markDiffReviewed(
  storage: StorageApi,
  workspaceId: string,
  branch: string | null,
  diffHash: string
): Promise<WorkspaceThread> {
  const thread = await loadThread(storage, workspaceId, branch)
  if (!thread.reviewedDiffHashes.includes(diffHash)) {
    thread.reviewedDiffHashes = [...thread.reviewedDiffHashes, diffHash].slice(
      -MAX_STORED_DIFF_HASHES
    )
    await saveThread(storage, thread)
  }
  return thread
}

export async function deleteWorkspaceThread(
  storage: StorageApi,
  workspaceId: string
): Promise<void> {
  await storage.delete(threadStorageKey(workspaceId))
}

export type HistoryMessage = {
  role: 'user' | 'assistant'
  content: string
}

export function buildHistoryMessages(
  entries: ThreadEntry[],
  maxEntries = 8,
  maxTotalChars = 36_000
): HistoryMessage[] {
  const valid = entries.filter((e) => !e.error && e.advice.trim().length > 0)
  const recent = valid.slice(-maxEntries)

  const pairs: { user: string; assistant: string }[] = recent.map((e) => {
    const contextHint = [
      e.context.branch ? `branch=${e.context.branch}` : null,
      `diff=+${e.context.diffAdded}/-${e.context.diffRemoved}`,
      e.context.filesIncluded.length > 0 ? `files=${e.context.filesIncluded.join(',')}` : null
    ]
      .filter(Boolean)
      .join(' ')
    const userContent = `[${e.source} @ ${new Date(e.at).toISOString()} | ${contextHint}]\nQuestion: ${e.question}`
    const assistantContent = e.advice
    return { user: userContent, assistant: assistantContent }
  })

  const selected: HistoryMessage[] = []
  let chars = 0
  for (let i = pairs.length - 1; i >= 0; i--) {
    const pair = pairs[i]
    const pairLen = pair.user.length + pair.assistant.length
    if (chars + pairLen > maxTotalChars && selected.length > 0) {
      break
    }
    chars += pairLen
    selected.unshift({ role: 'user', content: pair.user }, { role: 'assistant', content: pair.assistant })
  }

  return selected
}
