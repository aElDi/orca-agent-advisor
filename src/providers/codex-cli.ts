import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveExecutable, spawnWithStdin } from './cli-exec'
import type { ProviderRequest, ProviderResponse } from './types'

export type CodexConfigSummary = {
  defaultModel: string | null
  reasoningEffort: string | null
  hasAdvisorMcp: boolean
}

export async function readCodexConfigSummary(
  configPath = path.join(os.homedir(), '.codex', 'config.toml')
): Promise<CodexConfigSummary> {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const modelMatch = raw.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m)
    const effortMatch = raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"'\r\n]+)["']/m)
    const hasAdvisorMcp = /^\s*\[mcp_servers\.advisor\]/m.test(raw)
    return {
      defaultModel: modelMatch ? modelMatch[1].trim() : null,
      reasoningEffort: effortMatch ? effortMatch[1].trim() : null,
      hasAdvisorMcp
    }
  } catch {
    return { defaultModel: null, reasoningEffort: null, hasAdvisorMcp: false }
  }
}

function buildCodexStdin(req: ProviderRequest): string {
  const parts: string[] = [
    `<system_instructions>\n${req.systemPrompt}\n</system_instructions>`
  ]
  if (req.history.length > 0) {
    const historyBlock = req.history
      .map((m) => `[${m.role === 'user' ? 'Executor Question' : 'Advisor Response'}]\n${m.content}`)
      .join('\n\n---\n\n')
    parts.push(`<prior_advisor_thread>\n${historyBlock}\n</prior_advisor_thread>`)
  }
  parts.push(`<current_consultation>\n${req.userMessage}\n</current_consultation>`)
  return parts.join('\n\n')
}

export async function runCodexCli(
  req: ProviderRequest,
  signal: AbortSignal
): Promise<ProviderResponse> {
  const execSpec = await resolveExecutable('codex')
  if (!execSpec) {
    throw new Error('Codex CLI (`codex`) was not found on PATH.')
  }

  const configSummary = await readCodexConfigSummary()
  const outFile = path.join(os.tmpdir(), `orca-advisor-codex-${randomUUID()}.txt`)
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--color',
    'never',
    '--skip-git-repo-check',
    '-o',
    outFile
  ]

  // Only disable mcp_servers.advisor if it is actually declared in config.toml
  // (otherwise Codex creates an invalid transport stub and refuses to start).
  if (configSummary.hasAdvisorMcp) {
    args.push('-c', 'mcp_servers.advisor.enabled=false')
  }

  if (req.reasoningEffort && req.reasoningEffort !== 'default') {
    const codexEffort = req.reasoningEffort === 'max' ? 'xhigh' : req.reasoningEffort
    args.push('-c', `model_reasoning_effort="${codexEffort}"`)
  }

  if (req.cwd) {
    args.push('-C', req.cwd)
  }
  if (req.model.trim()) {
    args.push('-m', req.model.trim())
  }
  args.push('-')

  try {
    const res = await spawnWithStdin(execSpec, args, buildCodexStdin(req), {
      cwd: req.cwd,
      signal,
      timeoutMs: 180_000
    })

    if (res.aborted) {
      throw new Error('Consultation cancelled.')
    }
    if (res.timedOut) {
      throw new Error('Codex CLI timed out after 180s.')
    }

    let outText = ''
    try {
      outText = (await fs.readFile(outFile, 'utf8')).trim()
    } catch {
      outText = ''
    }

    if (res.code !== 0 && !outText) {
      throw new Error(
        res.stderr.trim() || res.stdout.trim() || `Codex CLI exited with code ${res.code}`
      )
    }

    const advice = outText || res.stdout.trim()
    if (!advice) {
      throw new Error(res.stderr.trim() || 'Codex CLI returned an empty response.')
    }

    return {
      advice,
      model: req.model.trim() || configSummary.defaultModel || 'codex-cli',
      usage: null
    }
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => undefined)
  }
}
