import { randomUUID } from 'node:crypto'
import type { SecretsApi, StorageApi } from 'orca/host'
import { collectConsultationContext, redactSecretPatterns } from './context'
import { parseAdvisorVerdict } from './guards'
import { callProvider, readBackendApiKey } from './providers'
import {
  appendThreadEntry,
  buildHistoryMessages,
  loadThread,
  resetWorkspaceThread
} from './threads'
import {
  resolveEffectiveModel,
  type ActiveRequest,
  type AdvisorSettings,
  type ConsultSource,
  type GlobalStats,
  type ReviewVerdict,
  type ThreadEntry,
  type WorkspaceThread
} from './types'

const BASE_SYSTEM_PROMPT = `You are a senior principal engineer acting as a read-only second-opinion advisor for a coding agent or developer working in a Git worktree.

Rules:
- You are strictly read-only. Never claim you edited files or ran commands; provide clear guidance the executor can act on.
- Ground every observation strictly in the question, prior advisor thread, git status/diff, referenced files, and terminal output supplied to you. If critical context is missing, state exactly which files or outputs the executor should check.
- Be concise, direct, and high-signal (~100-350 words unless deeper analysis is explicitly requested). Skip pleasantries and filler.
- Focus on architectural blind spots, subtle bugs, race conditions, security flaws, edge cases, simpler alternatives, and verification gaps.
- Give numbered, concrete next steps or fixes.
- When asked to review code or a git diff: begin the very first line with "VERDICT: LGTM" if there are no material defects, or "VERDICT: CHANGES_REQUESTED" followed by specific numbered fixes if issues remain.`

export function buildAdvisorSystemPrompt(customSystemPrompt: string): string {
  const extra = customSystemPrompt.trim()
  return extra ? `${BASE_SYSTEM_PROMPT}\n\nAdditional instructions:\n${extra}` : BASE_SYSTEM_PROMPT
}

export type ConsultInput = {
  requestId?: string
  workspaceId: string
  workspacePath: string | null
  branchHint: string | null
  source: ConsultSource
  agent: string | null
  question: string
  files?: string[]
  includeDiff?: boolean
  terminalLines?: string[]
  settings: AdvisorSettings
  storage: StorageApi
  secrets: SecretsApi
}

export type ConsultOutcome = {
  entry: ThreadEntry
  thread: WorkspaceThread
  stats: GlobalStats
  diffHash: string
  verdict: ReviewVerdict | null
}

export class AdvisorEngine {
  private readonly controllers = new Map<string, AbortController>()
  private readonly workspaceQueues = new Map<string, Promise<unknown>>()

  createRequestHandle(params: {
    workspaceId: string
    source: ConsultSource
    agent: string | null
    question: string
  }): ActiveRequest {
    return {
      requestId: randomUUID(),
      workspaceId: params.workspaceId,
      source: params.source,
      agent: params.agent,
      question: params.question,
      startedAt: Date.now()
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.controllers.clear()
  }

  private enqueueWorkspace<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.workspaceQueues.get(workspaceId) ?? Promise.resolve()
    const next = prev.then(task, task)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.workspaceQueues.set(workspaceId, settled)
    return next
  }

  async runConsultation(
    input: ConsultInput,
    externalSignal?: AbortSignal
  ): Promise<ConsultOutcome> {
    const requestId = input.requestId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(requestId, controller)

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort()
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    try {
      return await this.enqueueWorkspace(input.workspaceId, async () => {
        if (controller.signal.aborted) {
          throw new Error('Consultation cancelled.')
        }

        const startedAt = Date.now()
        const context = await collectConsultationContext({
          workspacePath: input.workspacePath,
          branchHint: input.branchHint,
          files: input.files,
          includeDiff: input.includeDiff ?? true,
          maxDiffChars: input.settings.maxDiffChars,
          terminalLines: input.terminalLines,
          redactSecrets: input.settings.redactSecrets
        })

        const currentBranch = context.summary.branch ?? input.branchHint
        let thread = await loadThread(input.storage, input.workspaceId, currentBranch)
        if (thread.branch && currentBranch && thread.branch !== currentBranch) {
          thread = await resetWorkspaceThread(input.storage, input.workspaceId, currentBranch)
        }

        const history = buildHistoryMessages(thread.entries)
        const cleanQuestion = input.settings.redactSecrets
          ? redactSecretPatterns(input.question.trim())
          : input.question.trim()

        const userMessage = [
          `## Question (${input.source}${input.agent ? `, agent: ${input.agent}` : ''})`,
          cleanQuestion,
          '',
          context.promptSection
        ].join('\n')

        const effectiveModel = resolveEffectiveModel(input.settings)
        const apiKey = await readBackendApiKey(input.secrets, input.settings.backend)
        const systemPrompt = buildAdvisorSystemPrompt(input.settings.customSystemPrompt)

        const response = await callProvider(
          input.settings.backend,
          {
            model: effectiveModel,
            orcaAgent: input.settings.orcaAgent,
            reasoningEffort: input.settings.reasoningEffort,
            apiKey,
            customBaseUrl: input.settings.customBaseUrl,
            systemPrompt,
            history,
            userMessage,
            cwd: input.workspacePath
          },
          controller.signal
        )

        const isReviewLike =
          input.source === 'auto-review' ||
          /\b(review|diff|verdict|lgtm|changes_requested)\b/i.test(cleanQuestion)
        const verdict = isReviewLike ? parseAdvisorVerdict(response.advice) : null

        const cleanUsage = response.usage
          ? {
              ...(typeof response.usage.inputTokens === 'number'
                ? { inputTokens: response.usage.inputTokens }
                : {}),
              ...(typeof response.usage.outputTokens === 'number'
                ? { outputTokens: response.usage.outputTokens }
                : {}),
              ...(typeof response.usage.cacheReadTokens === 'number'
                ? { cacheReadTokens: response.usage.cacheReadTokens }
                : {}),
              ...(typeof response.usage.cacheWriteTokens === 'number'
                ? { cacheWriteTokens: response.usage.cacheWriteTokens }
                : {}),
              ...(typeof response.usage.costUsd === 'number'
                ? { costUsd: response.usage.costUsd }
                : {})
            }
          : null

        const entry: ThreadEntry = {
          id: requestId,
          at: Date.now(),
          source: input.source,
          agent: input.agent,
          question: cleanQuestion,
          advice: response.advice,
          backend: input.settings.backend,
          model: response.model,
          latencyMs: Date.now() - startedAt,
          usage: cleanUsage && Object.keys(cleanUsage).length > 0 ? cleanUsage : null,
          context: context.summary,
          verdict,
          ...(response.orcaSessionId ? { orcaSessionId: response.orcaSessionId } : {})
        }

        const saved = await appendThreadEntry(
          input.storage,
          input.workspaceId,
          currentBranch,
          entry,
          {
            incrementMcpUse: input.source === 'mcp',
            reviewedDiffHash: isReviewLike && context.diffHash !== 'none' ? context.diffHash : undefined
          }
        )

        return {
          entry,
          thread: saved.thread,
          stats: saved.stats,
          diffHash: context.diffHash,
          verdict
        }
      })
    } finally {
      this.controllers.delete(requestId)
    }
  }
}
