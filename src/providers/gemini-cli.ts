import { resolveExecutable, spawnWithStdin } from './cli-exec'
import type { ProviderRequest, ProviderResponse } from './types'

function buildGeminiStdin(req: ProviderRequest): string {
  const parts: string[] = [
    '[STRICT READ-ONLY ADVISOR MODE — Do NOT edit files, do NOT run shell commands, do NOT invoke the `advisor` MCP tool.]',
    req.systemPrompt
  ]

  if (req.history.length > 0) {
    const recent = req.history.slice(-6)
    const hist = recent
      .map((m) => `[${m.role === 'user' ? 'Executor' : 'Advisor'}]\n${m.content.slice(0, 1800)}`)
      .join('\n---\n')
    parts.push(`<prior_thread>\n${hist}\n</prior_thread>`)
  }

  parts.push(req.userMessage)
  return parts.join('\n\n')
}

export async function runGeminiCli(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const execSpec = await resolveExecutable('gemini')
  if (!execSpec) {
    throw new Error('Gemini CLI (`gemini`) was not found on PATH.')
  }

  const args = ['-p', '', '--approval-mode', 'plan', '--output-format', 'json']
  const trimmedModel = req.model.trim()
  if (trimmedModel) {
    args.push('-m', trimmedModel)
  }

  const res = await spawnWithStdin(execSpec, args, buildGeminiStdin(req), {
    cwd: req.cwd,
    signal,
    timeoutMs: req.timeoutMs ?? 180_000,
    stripElectronRunAsNode: true
  })

  if (res.aborted) throw new Error('Consultation cancelled.')
  if (res.timedOut) throw new Error('Gemini CLI timed out.')

  const raw = res.stdout.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        response?: string
        text?: string
        result?: string
        error?: { message?: string } | string
      }
      const advice = (parsed.response ?? parsed.text ?? parsed.result ?? '').trim()
      if (advice) {
        return {
          advice,
          model: trimmedModel || 'gemini',
          usage: null
        }
      }
      if (parsed.error) {
        const msg =
          typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error.message ?? JSON.stringify(parsed.error)
        throw new Error(`Gemini CLI error: ${msg}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Gemini CLI error:')) throw e
    }
  }

  if (res.code !== 0) {
    const errMsg = res.stderr.trim() || raw || `gemini exited with code ${res.code}`
    throw new Error(`Gemini CLI error: ${errMsg.slice(0, 600)}`)
  }

  if (!raw) {
    throw new Error('Gemini CLI returned an empty response.')
  }

  return {
    advice: raw,
    model: trimmedModel || 'gemini',
    usage: null
  }
}
