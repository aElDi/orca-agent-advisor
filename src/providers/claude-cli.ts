import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveExecutable, spawnWithStdin } from './cli-exec'
import type { ProviderRequest, ProviderResponse } from './types'

async function ensureEmptyMcpConfigFile(): Promise<string> {
  const dir = path.join(os.homedir(), '.orca-agent-advisor')
  const filePath = path.join(dir, 'empty-mcp.json')
  try {
    await fs.access(filePath)
    return filePath
  } catch {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, '{"mcpServers":{}}\n', 'utf8')
    return filePath
  }
}

function buildClaudeStdin(req: ProviderRequest): string {
  if (req.history.length === 0) {
    return req.userMessage
  }
  const historyBlock = req.history
    .map((m) => `[${m.role === 'user' ? 'Executor Question' : 'Advisor Response'}]\n${m.content}`)
    .join('\n\n---\n\n')
  return `<prior_advisor_thread>\n${historyBlock}\n</prior_advisor_thread>\n\n<current_consultation>\n${req.userMessage}\n</current_consultation>`
}

export async function runClaudeCli(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const execSpec = await resolveExecutable('claude')
  if (!execSpec) {
    throw new Error('Claude CLI (`claude`) was not found on PATH.')
  }

  const emptyMcpPath = await ensureEmptyMcpConfigFile()
  const args = [
    '-p',
    '--tools',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    emptyMcpPath,
    '--output-format',
    'json',
    '--system-prompt',
    req.systemPrompt
  ]

  if (req.model.trim()) {
    args.push('--model', req.model.trim())
  }
  if (req.reasoningEffort && req.reasoningEffort !== 'default') {
    args.push('--effort', req.reasoningEffort)
  }

  const res = await spawnWithStdin(execSpec, args, buildClaudeStdin(req), {
    cwd: req.cwd,
    signal,
    timeoutMs: 180_000
  })

  if (res.aborted) {
    throw new Error('Consultation cancelled.')
  }
  if (res.timedOut) {
    throw new Error('Claude CLI timed out after 180s.')
  }

  const stdout = res.stdout.trim()
  const stderr = res.stderr.trim()

  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as {
        is_error?: boolean
        result?: string
        errors?: string[]
        total_cost_usd?: number
        modelUsage?: Record<string, unknown>
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }

      if (parsed.is_error || res.code !== 0) {
        const msg =
          parsed.result ||
          parsed.errors?.join('; ') ||
          stderr ||
          `Claude CLI exited with code ${res.code}`
        throw new Error(msg)
      }

      const advice = (parsed.result ?? '').trim()
      if (!advice) {
        throw new Error('Claude CLI returned an empty result.')
      }

      const resolvedModelFromUsage =
        parsed.modelUsage && typeof parsed.modelUsage === 'object'
          ? Object.keys(parsed.modelUsage)[0]
          : undefined

      return {
        advice,
        model: resolvedModelFromUsage || req.model.trim() || 'claude-cli',
        usage: parsed.usage
          ? {
              inputTokens: parsed.usage.input_tokens,
              outputTokens: parsed.usage.output_tokens,
              cacheReadTokens: parsed.usage.cache_read_input_tokens,
              cacheWriteTokens: parsed.usage.cache_creation_input_tokens,
              costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined
            }
          : typeof parsed.total_cost_usd === 'number'
            ? { costUsd: parsed.total_cost_usd }
            : null
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        if (res.code === 0) {
          return { advice: stdout, model: req.model.trim() || 'claude-cli', usage: null }
        }
      } else {
        throw err
      }
    }
  }

  throw new Error(stderr || stdout || `Claude CLI failed (exit code ${res.code}).`)
}
