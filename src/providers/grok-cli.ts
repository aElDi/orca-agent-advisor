import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveExecutable, spawnWithStdin } from './cli-exec'
import type { ProviderRequest, ProviderResponse } from './types'

function buildGrokPrompt(req: ProviderRequest): string {
  const sections: string[] = [
    '[STRICT READ-ONLY ADVISOR MODE — Do NOT edit files, do NOT run shell commands, do NOT invoke the `advisor` MCP tool. Give concise, high-signal architectural and debugging advice (400-700 tokens).]'
  ]

  if (req.history.length > 0) {
    const recent = req.history.slice(-6)
    const hist = recent
      .map((m) => `[${m.role === 'user' ? 'Executor' : 'Advisor'}]\n${m.content.slice(0, 1800)}`)
      .join('\n---\n')
    sections.push(`<prior_thread>\n${hist}\n</prior_thread>`)
  }

  sections.push(req.userMessage)
  return sections.join('\n\n')
}

export async function runGrokCli(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const execSpec = await resolveExecutable('grok')
  if (!execSpec) {
    throw new Error('Grok CLI (`grok`) was not found on PATH.')
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-grok-'))
  const sysPath = path.join(tmpDir, 'system.txt')
  const promptPath = path.join(tmpDir, 'prompt.txt')

  try {
    await fs.writeFile(sysPath, req.systemPrompt, 'utf8')
    await fs.writeFile(promptPath, buildGrokPrompt(req), 'utf8')

    const args = [
      '--prompt-file',
      promptPath,
      '--system-prompt-file',
      sysPath,
      '--output-format',
      'json',
      '--disable-web-search'
    ]

    const trimmedModel = req.model.trim()
    if (trimmedModel) {
      args.push('--model', trimmedModel)
    }

    if (req.reasoningEffort && req.reasoningEffort !== 'default') {
      const mapped = req.reasoningEffort === 'max' ? 'xhigh' : req.reasoningEffort
      args.push('--reasoning-effort', mapped)
    }

    const res = await spawnWithStdin(execSpec, args, '', {
      cwd: req.cwd,
      signal,
      timeoutMs: req.timeoutMs ?? 180_000,
      stripElectronRunAsNode: true
    })

    if (res.aborted) throw new Error('Consultation cancelled.')
    if (res.timedOut) throw new Error('Grok CLI timed out.')

    const raw = res.stdout.trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          text?: string
          result?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
          }
          total_cost_usd?: number
          modelUsage?: Record<string, unknown>
          error?: string
        }
        const advice = (parsed.text ?? parsed.result ?? '').trim()
        if (advice) {
          const usedModel =
            trimmedModel ||
            (parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : '') ||
            'grok'
          return {
            advice,
            model: usedModel,
            usage: parsed.usage
              ? {
                  inputTokens: parsed.usage.input_tokens,
                  outputTokens: parsed.usage.output_tokens,
                  cacheReadTokens: parsed.usage.cache_read_input_tokens,
                  costUsd:
                    typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined
                }
              : null
          }
        }
        if (parsed.error) {
          throw new Error(`Grok CLI error: ${parsed.error}`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Grok CLI error:')) throw e
        // fall through to plain text check
      }
    }

    if (res.code !== 0) {
      const errMsg = res.stderr.trim() || raw || `grok exited with code ${res.code}`
      throw new Error(`Grok CLI error: ${errMsg.slice(0, 600)}`)
    }

    if (!raw) {
      throw new Error('Grok CLI returned an empty response.')
    }

    return {
      advice: raw,
      model: trimmedModel || 'grok',
      usage: null
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
