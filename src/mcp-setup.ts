import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SecretsApi } from 'orca/host'
import { getDiscoveryFilePath, getMcpScriptPath } from './ipc'
import { resolveExecutable, spawnWithStdin } from './providers/cli-exec'
import { secretKeyForBackend } from './providers'
import type { AgentSetupInfo, SetupStatus } from './types'

const GLOBAL_SKILL_CONTENT = `---
name: advisor
description: Consult a stronger read-only second-opinion advisor model on architecture, plans, recurring bugs, or diff reviews.
---

# Advisor

When invoked via \`/advisor\` or when tackling a non-trivial decision, stuck loop, or pre-finish verification:

1. Summarize your current goal, what you already inspected or tried, and the exact question or diff to verify.
2. Call the \`advisor\` MCP tool with \`question\` (and optional \`files\`, \`includeDiff\`, \`includeTerminal\`). Do not copy-paste whole files into \`question\`—pass relative paths in \`files\` so the plugin reads them directly.
3. Treat the advisor's answer as second-opinion guidance: verify assumptions against the codebase and execute edits yourself.
`

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export function getGlobalSkillPath(): string {
  return path.join(os.homedir(), '.agents', 'skills', 'advisor', 'SKILL.md')
}

async function checkClaudeConfigured(): Promise<boolean> {
  const claudeJson = await readJsonSafe(path.join(os.homedir(), '.claude.json'))
  const servers = claudeJson?.mcpServers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    if ('advisor' in servers) return true
  }
  const claudeSettings = await readJsonSafe(path.join(os.homedir(), '.claude', 'settings.json'))
  const settingsServers = claudeSettings?.mcpServers
  if (settingsServers && typeof settingsServers === 'object' && !Array.isArray(settingsServers)) {
    if ('advisor' in settingsServers) return true
  }
  return false
}

async function checkCodexConfigured(): Promise<boolean> {
  try {
    const toml = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
    return /^\s*\[mcp_servers\.advisor\]/m.test(toml)
  } catch {
    return false
  }
}

function getOpenCodeConfigCandidates(): string[] {
  const home = os.homedir()
  const candidates = [path.join(home, '.config', 'opencode', 'opencode.json')]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    if (appData) {
      candidates.push(path.join(appData, 'opencode', 'opencode.json'))
    }
  }
  return candidates
}

async function resolveOpenCodeConfigPath(): Promise<string> {
  const candidates = getOpenCodeConfigCandidates()
  for (const p of candidates) {
    if (await fileExists(p)) return p
  }
  return candidates[0]
}

async function checkOpenCodeConfigured(): Promise<boolean> {
  for (const p of getOpenCodeConfigCandidates()) {
    const json = await readJsonSafe(p)
    const mcp = json?.mcp
    if (mcp && typeof mcp === 'object' && !Array.isArray(mcp) && 'advisor' in mcp) {
      return true
    }
  }
  return false
}

export async function getSetupStatus(params: {
  workspacePath: string | null
  secrets: SecretsApi
  secretsProtection?: 'os-keyring' | 'unavailable'
  ipcRunning: boolean
  ipcPort: number | null
}): Promise<SetupStatus> {
  const mcpScriptPath = getMcpScriptPath()
  const ipcFile = getDiscoveryFilePath()
  const skillPath = getGlobalSkillPath()

  const [
    claudeExec,
    codexExec,
    opencodeExec,
    claudeConfigured,
    codexConfigured,
    opencodeConfigured,
    skillInstalled,
    openrouterKey,
    anthropicKey,
    openaiKey
  ] = await Promise.all([
    resolveExecutable('claude'),
    resolveExecutable('codex'),
    resolveExecutable('opencode'),
    checkClaudeConfigured(),
    checkCodexConfigured(),
    checkOpenCodeConfigured(),
    fileExists(skillPath),
    params.secrets.get(secretKeyForBackend('openrouter')).catch(() => null),
    params.secrets.get(secretKeyForBackend('anthropic')).catch(() => null),
    params.secrets.get(secretKeyForBackend('openai')).catch(() => null)
  ])

  let workspaceMcpConfigured = false
  let workspaceMcpPath: string | null = null
  if (params.workspacePath) {
    workspaceMcpPath = path.join(params.workspacePath, '.mcp.json')
    const wsJson = await readJsonSafe(workspaceMcpPath)
    const servers = wsJson?.mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      workspaceMcpConfigured = 'advisor' in servers
    }
  }

  const agents: AgentSetupInfo[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: Boolean(claudeExec),
      commandPath: claudeExec?.displayPath ?? null,
      mcpConfigured: claudeConfigured,
      detail: claudeExec
        ? claudeConfigured
          ? 'Registered in user MCP config'
          : 'CLI detected; ready to register'
        : 'CLI not found on PATH'
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      installed: Boolean(codexExec),
      commandPath: codexExec?.displayPath ?? null,
      mcpConfigured: codexConfigured,
      detail: codexExec
        ? codexConfigured
          ? 'Registered in ~/.codex/config.toml'
          : 'CLI detected; ready to register'
        : 'CLI not found on PATH'
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      installed: Boolean(opencodeExec),
      commandPath: opencodeExec?.displayPath ?? null,
      mcpConfigured: opencodeConfigured,
      detail: opencodeExec
        ? opencodeConfigured
          ? 'Registered in opencode.json'
          : 'CLI detected; ready to register'
        : 'CLI not found on PATH'
    }
  ]

  const manualSnippetJson = JSON.stringify(
    {
      mcpServers: {
        advisor: {
          command: 'node',
          args: [mcpScriptPath]
        }
      }
    },
    null,
    2
  )

  return {
    ipcRunning: params.ipcRunning,
    ipcPort: params.ipcPort,
    ipcFile,
    mcpScriptPath,
    secretsProtection: params.secretsProtection ?? 'os-keyring',
    savedKeys: {
      openrouter: Boolean(openrouterKey),
      anthropic: Boolean(anthropicKey),
      openai: Boolean(openaiKey)
    },
    agents,
    workspaceMcpJson: {
      path: workspaceMcpPath,
      configured: workspaceMcpConfigured
    },
    globalSkill: {
      path: skillPath,
      installed: skillInstalled
    },
    manualSnippetJson
  }
}

export async function installMcpTarget(
  target: 'claude' | 'codex' | 'opencode' | 'workspace-mcp-json',
  workspacePath: string | null
): Promise<{ ok: boolean; message: string }> {
  const mcpScriptPath = getMcpScriptPath()

  if (target === 'claude') {
    const execSpec = await resolveExecutable('claude')
    if (!execSpec) {
      return { ok: false, message: 'Claude CLI not found on PATH.' }
    }
    const res = await spawnWithStdin(
      execSpec,
      ['mcp', 'add', '--scope', 'user', 'advisor', '--', 'node', mcpScriptPath],
      '',
      { timeoutMs: 20_000 }
    )
    if (res.code !== 0) {
      return {
        ok: false,
        message: res.stderr.trim() || res.stdout.trim() || `claude mcp add exited with ${res.code}`
      }
    }
    return { ok: true, message: 'Registered "advisor" MCP server in Claude Code (user scope).' }
  }

  if (target === 'codex') {
    const execSpec = await resolveExecutable('codex')
    if (!execSpec) {
      return { ok: false, message: 'Codex CLI not found on PATH.' }
    }
    const res = await spawnWithStdin(
      execSpec,
      ['mcp', 'add', 'advisor', '--', 'node', mcpScriptPath],
      '',
      { timeoutMs: 20_000 }
    )
    if (res.code !== 0) {
      return {
        ok: false,
        message: res.stderr.trim() || res.stdout.trim() || `codex mcp add exited with ${res.code}`
      }
    }
    return { ok: true, message: 'Registered "advisor" MCP server in Codex CLI.' }
  }

  if (target === 'opencode') {
    const configPath = await resolveOpenCodeConfigPath()
    const existing = (await readJsonSafe(configPath)) ?? {}
    const existingMcp =
      existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
        ? (existing.mcp as Record<string, unknown>)
        : {}
    const nextConfig = {
      ...existing,
      mcp: {
        ...existingMcp,
        advisor: {
          type: 'local',
          command: ['node', mcpScriptPath],
          enabled: true
        }
      }
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8')
    return { ok: true, message: `Updated ${configPath} with "advisor" MCP server.` }
  }

  if (!workspacePath) {
    return { ok: false, message: 'No active workspace selected.' }
  }

  const mcpJsonPath = path.join(workspacePath, '.mcp.json')
  const existing = (await readJsonSafe(mcpJsonPath)) ?? {}
  const existingServers =
    existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {}
  const nextJson = {
    ...existing,
    mcpServers: {
      ...existingServers,
      advisor: {
        command: 'node',
        args: [mcpScriptPath]
      }
    }
  }
  await fs.writeFile(mcpJsonPath, JSON.stringify(nextJson, null, 2) + '\n', 'utf8')
  return { ok: true, message: `Wrote "advisor" MCP entry to ${mcpJsonPath}.` }
}

export async function installGlobalSkill(): Promise<{ ok: boolean; path: string; message: string }> {
  const skillPath = getGlobalSkillPath()
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await fs.writeFile(skillPath, GLOBAL_SKILL_CONTENT, 'utf8')

  // Mirror /advisor skill into installed agent skill folders if their base directory exists
  const home = os.homedir()
  const agentBaseDirs = [
    path.join(home, '.codex'),
    path.join(home, '.grok'),
    path.join(home, '.gemini'),
    path.join(home, '.claude')
  ]
  for (const baseDir of agentBaseDirs) {
    if (await fileExists(baseDir)) {
      const target = path.join(baseDir, 'skills', 'advisor', 'SKILL.md')
      await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined)
      await fs.writeFile(target, GLOBAL_SKILL_CONTENT, 'utf8').catch(() => undefined)
    }
  }

  return {
    ok: true,
    path: skillPath,
    message: `Installed /advisor skill at ${skillPath}.`
  }
}

async function ensureJsonMcpServersEntry(
  configPath: string,
  mcpScriptPath: string
): Promise<boolean> {
  const existing = (await readJsonSafe(configPath)) ?? {}
  const existingServers =
    existing.mcpServers &&
    typeof existing.mcpServers === 'object' &&
    !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {}

  if ('advisor' in existingServers) {
    return true
  }

  const nextJson = {
    ...existing,
    mcpServers: {
      ...existingServers,
      advisor: {
        command: 'node',
        args: [mcpScriptPath]
      }
    }
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(nextJson, null, 2) + '\n', 'utf8')
  return true
}

async function hasGrokAdvisorSection(configPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(configPath, 'utf8')
    return /^\s*\[mcp_servers\.advisor\]/m.test(content)
  } catch {
    return false
  }
}

async function ensureGrokMcpConfigured(
  mcpScriptPath: string,
  log?: (msg: string) => void
): Promise<boolean> {
  const grokDir = path.join(os.homedir(), '.grok')
  const configPath = path.join(grokDir, 'config.toml')
  if (await hasGrokAdvisorSection(configPath)) {
    return true
  }

  const execSpec = await resolveExecutable('grok')
  if (!execSpec && !(await fileExists(grokDir))) return false

  if (execSpec) {
    const res = await spawnWithStdin(
      execSpec,
      ['mcp', 'add', '--scope', 'user', 'advisor', '--', 'node', mcpScriptPath],
      '',
      { timeoutMs: 20_000, stripElectronRunAsNode: true }
    )
    if (res.code === 0 || (await hasGrokAdvisorSection(configPath))) {
      log?.('Auto-registered advisor MCP in Grok via `grok mcp add`')
      return true
    }
    log?.(`grok mcp add failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
  }

  // Fallback: only append if still absent after re-checking file
  if ((await fileExists(configPath)) && !(await hasGrokAdvisorSection(configPath))) {
    const escapedScript = mcpScriptPath.replace(/\\/g, '\\\\')
    const block = `\n[mcp_servers.advisor]\ncommand = "node"\nargs = ["${escapedScript}"]\nenabled = true\n`
    await fs.appendFile(configPath, block, 'utf8')
    log?.('Auto-registered advisor MCP in ~/.grok/config.toml')
    return true
  }
  return false
}

async function ensureKiloMcpConfigured(
  mcpScriptPath: string,
  log?: (msg: string) => void
): Promise<boolean> {
  const kiloDir = path.join(os.homedir(), '.config', 'kilo')
  if (!(await fileExists(kiloDir))) return false

  const candidates = [path.join(kiloDir, 'kilo.json'), path.join(kiloDir, 'kilo.jsonc')]
  let configPath = candidates[0]
  for (const c of candidates) {
    if (await fileExists(c)) {
      configPath = c
      break
    }
  }

  const existing = await readJsonSafe(configPath)
  if (!existing && (await fileExists(configPath))) {
    // File has JSONC comments; avoid corrupting user's commented file
    return false
  }
  const base = existing ?? {}
  const existingMcp =
    base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp)
      ? (base.mcp as Record<string, unknown>)
      : {}
  if ('advisor' in existingMcp) return true

  const nextConfig = {
    ...base,
    mcp: {
      ...existingMcp,
      advisor: {
        type: 'local',
        command: ['node', mcpScriptPath],
        enabled: true
      }
    }
  }
  await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8')
  log?.(`Auto-registered advisor MCP in ${configPath}`)
  return true
}

let inFlightAutoSetup: Promise<{ connectedAgents: string[]; skillInstalled: boolean }> | null = null

export async function ensureAutoSetup(
  log?: (msg: string) => void
): Promise<{ connectedAgents: string[]; skillInstalled: boolean }> {
  if (inFlightAutoSetup) return inFlightAutoSetup
  inFlightAutoSetup = runAutoSetupOnce(log).finally(() => {
    inFlightAutoSetup = null
  })
  return inFlightAutoSetup
}

async function runAutoSetupOnce(
  log?: (msg: string) => void
): Promise<{ connectedAgents: string[]; skillInstalled: boolean }> {
  const connectedAgents: string[] = []
  let skillInstalled = false
  const mcpScriptPath = getMcpScriptPath()
  const home = os.homedir()

  // 1. Automatically install / sync global /advisor skill everywhere
  try {
    await installGlobalSkill()
    skillInstalled = true
  } catch (err) {
    log?.(
      `Auto-install /advisor skill failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 2. Claude, Codex, OpenCode
  const cliTargets: {
    id: 'claude' | 'codex' | 'opencode'
    label: string
    check: () => Promise<boolean>
  }[] = [
    { id: 'claude', label: 'Claude', check: checkClaudeConfigured },
    { id: 'codex', label: 'Codex', check: checkCodexConfigured },
    { id: 'opencode', label: 'OpenCode', check: checkOpenCodeConfigured }
  ]

  for (const t of cliTargets) {
    try {
      const exec = await resolveExecutable(t.id)
      if (!exec) continue
      if (await t.check()) {
        connectedAgents.push(t.label)
        continue
      }
      const res = await installMcpTarget(t.id, null)
      if (res.ok) {
        connectedAgents.push(t.label)
        log?.(`Auto-registered advisor MCP in ${t.label}`)
      } else {
        log?.(`Auto-register advisor MCP in ${t.label} skipped: ${res.message}`)
      }
    } catch (err) {
      log?.(
        `Auto-register advisor MCP in ${t.label} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // 3. Grok
  try {
    if (await ensureGrokMcpConfigured(mcpScriptPath, log)) {
      connectedAgents.push('Grok')
    }
  } catch (err) {
    log?.(`Auto-register advisor MCP in Grok failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Gemini CLI (~/.gemini/settings.json)
  try {
    const geminiSettings = path.join(home, '.gemini', 'settings.json')
    if (await fileExists(geminiSettings)) {
      await ensureJsonMcpServersEntry(geminiSettings, mcpScriptPath)
      connectedAgents.push('Gemini')
    }
  } catch (err) {
    log?.(`Auto-register advisor MCP in Gemini failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 5. Antigravity (~/.gemini/antigravity/mcp_config.json)
  try {
    const agDir = path.join(home, '.gemini', 'antigravity')
    if (await fileExists(agDir)) {
      await ensureJsonMcpServersEntry(path.join(agDir, 'mcp_config.json'), mcpScriptPath)
      connectedAgents.push('Antigravity')
    }
  } catch (err) {
    log?.(
      `Auto-register advisor MCP in Antigravity failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 6. Cline CLI (~/.cline/data/settings/cline_mcp_settings.json)
  try {
    const clineDir = path.join(home, '.cline', 'data', 'settings')
    if (await fileExists(clineDir)) {
      await ensureJsonMcpServersEntry(path.join(clineDir, 'cline_mcp_settings.json'), mcpScriptPath)
      connectedAgents.push('Cline')
    }
  } catch (err) {
    log?.(`Auto-register advisor MCP in Cline failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 7. Kilocode (~/.config/kilo/kilo.json(c))
  try {
    if (await ensureKiloMcpConfigured(mcpScriptPath, log)) {
      connectedAgents.push('Kilo')
    }
  } catch (err) {
    log?.(`Auto-register advisor MCP in Kilo failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { connectedAgents, skillInstalled }
}
