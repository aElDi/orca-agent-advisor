import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

const SERVER_INFO = {
  name: 'agent-advisor',
  version: '0.1.0'
}

const TOOL_DEFINITION = {
  name: 'advisor',
  description: [
    'Consult a stronger read-only second-opinion advisor model on anything: architecture choices, plan sanity-checks, tricky bugs, edge cases, or diff reviews.',
    'The advisor maintains a persistent thread per workspace branch so it remembers prior guidance across the task.',
    'Guidance:',
    '- Do quick orientation (read files/search) first, then call advisor BEFORE substantive edits or committing to a non-trivial approach.',
    '- Call advisor if stuck on recurring errors or an approach that is not converging.',
    '- On multi-step tasks, call advisor once before declaring done (after files are written) to review the diff.',
    '- Skip on trivial 1-step edits.',
    '- Treat advisor output as guidance: verify assumptions against the codebase and apply edits yourself.'
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Anything you want to ask, sanity-check, debug, or review with the advisor.'
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional relative paths of workspace files the advisor should read from disk.'
      },
      includeDiff: {
        type: 'boolean',
        default: true,
        description: 'Automatically attach current git status and git diff (default: true).'
      },
      includeTerminal: {
        type: 'boolean',
        default: false,
        description: 'Automatically attach the tail of the active Orca terminal output (default: false).'
      }
    },
    required: ['question'],
    additionalProperties: false
  }
}

const inFlightRequests = new Map()

function writeResponse(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function sendResult(id, result) {
  writeResponse({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data }
  writeResponse({ jsonrpc: '2.0', id, error })
}

function getDiscoveryFilePath() {
  const override = process.env.AGENT_ADVISOR_IPC_FILE
  if (override && override.trim()) return override.trim()
  return path.join(os.homedir(), '.orca-agent-advisor', 'ipc.json')
}

async function readIpcConfig() {
  const discoveryFile = getDiscoveryFilePath()
  const raw = await fs.readFile(discoveryFile, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
    throw new Error('Invalid IPC discovery payload')
  }
  return parsed
}

async function handleAdvisorCall(args, signal) {
  const question = typeof args?.question === 'string' ? args.question.trim() : ''
  if (!question) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Invalid arguments: "question" must be a non-empty string.' }]
    }
  }

  let ipc
  try {
    ipc = await readIpcConfig()
  } catch {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Agent Advisor plugin worker is not running in Orca. Enable Agent Advisor in Orca Settings -> Plugins and try again.'
        }
      ]
    }
  }

  const files = Array.isArray(args?.files)
    ? args.files.filter((f) => typeof f === 'string' && f.trim().length > 0)
    : undefined

  const payload = {
    question,
    files,
    includeDiff: typeof args?.includeDiff === 'boolean' ? args.includeDiff : true,
    includeTerminal: typeof args?.includeTerminal === 'boolean' ? args.includeTerminal : false,
    cwd: process.cwd(),
    workspaceId: process.env.AGENT_ADVISOR_WORKSPACE_ID || null,
    terminalId: process.env.AGENT_ADVISOR_TERMINAL_ID || null,
    agent: process.env.AGENT_ADVISOR_AGENT || null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 200_000)
  const onParentAbort = () => controller.abort()
  signal.addEventListener('abort', onParentAbort, { once: true })

  try {
    const res = await fetch(`http://127.0.0.1:${ipc.port}/v1/consult`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-advisor-token': ipc.token
      },
      body: JSON.stringify(payload)
    })

    const data = await res.json().catch(() => null)
    if (!res.ok || !data) {
      const errMsg = data?.error || `Worker IPC returned HTTP ${res.status}`
      return {
        isError: true,
        content: [{ type: 'text', text: `Advisor error: ${errMsg}` }]
      }
    }

    return {
      isError: !data.ok,
      content: [{ type: 'text', text: String(data.advice || data.error || '') }]
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError'
    const msg = isAbort
      ? 'Advisor request was cancelled or timed out.'
      : `Could not reach Orca Agent Advisor worker (${err instanceof Error ? err.message : String(err)}). Ensure the plugin is enabled in Orca.`
    return {
      isError: true,
      content: [{ type: 'text', text: msg }]
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onParentAbort)
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined && msg.id !== null
  const id = msg.id
  const method = msg.method
  const params = msg.params

  if (typeof method !== 'string') {
    if (hasId) sendError(id, -32600, 'Invalid Request')
    return
  }

  if (method === 'notifications/initialized') {
    return
  }

  if (method === 'notifications/cancelled') {
    const cancelId = params?.requestId
    const ac = cancelId !== undefined ? inFlightRequests.get(cancelId) : undefined
    if (ac) ac.abort()
    return
  }

  if (!hasId) {
    return
  }

  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05'
    const protocolVersion =
      requested === '2025-03-26' || requested === '2024-11-05' ? requested : '2024-11-05'
    sendResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    })
    return
  }

  if (method === 'ping') {
    sendResult(id, {})
    return
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: [TOOL_DEFINITION] })
    return
  }

  if (method === 'tools/call') {
    if (params?.name !== 'advisor') {
      sendError(id, -32602, `Unknown tool: ${String(params?.name ?? '')}`)
      return
    }
    const ac = new AbortController()
    inFlightRequests.set(id, ac)
    try {
      const result = await handleAdvisorCall(params?.arguments ?? {}, ac.signal)
      sendResult(id, result)
    } finally {
      inFlightRequests.delete(id)
    }
    return
  }

  sendError(id, -32601, `Method not found: ${method}`)
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    sendError(null, -32700, 'Parse error')
    return
  }

  void handleMessage(parsed).catch((err) => {
    process.stderr.write(`[agent-advisor-mcp] ${err instanceof Error ? err.stack : String(err)}\n`)
    if (parsed && parsed.id !== undefined && parsed.id !== null) {
      sendError(parsed.id, -32603, 'Internal error')
    }
  })
})

rl.on('close', () => {
  for (const ac of inFlightRequests.values()) {
    ac.abort()
  }
  inFlightRequests.clear()
})
