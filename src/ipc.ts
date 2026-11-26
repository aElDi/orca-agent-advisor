import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BODY_BYTES = 256 * 1024

export function getDiscoveryFilePath(): string {
  const override = process.env.AGENT_ADVISOR_IPC_FILE?.trim()
  if (override) return override
  return path.join(os.homedir(), '.orca-agent-advisor', 'ipc.json')
}

export function getMcpScriptPath(): string {
  return fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))
}

export type IpcConsultPayload = {
  question?: unknown
  files?: unknown
  includeDiff?: unknown
  includeTerminal?: unknown
  cwd?: unknown
  workspaceId?: unknown
  terminalId?: unknown
  agent?: unknown
}

export type IpcConsultResult = {
  ok: boolean
  advice: string
  budgetExceeded?: boolean
  meta?: {
    workspaceId: string | null
    branch: string | null
    backend: string
    model: string
    turnMcpUses: number
    maxUsesPerTurn: number
    latencyMs: number
  }
}

export type IpcServerHandle = {
  running: boolean
  port: number | null
  token: string
  discoveryFile: string
  stop: () => Promise<void>
}

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

async function readJsonBody(req: http.IncomingMessage): Promise<IpcConsultPayload> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 256 KiB limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = text ? JSON.parse(text) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Expected JSON object body'))
          return
        }
        resolve(parsed as IpcConsultPayload)
      } catch {
        reject(new Error('Invalid JSON request body'))
      }
    })

    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8')
  })
  res.end(text)
}

export async function startIpcServer(handlers: {
  onConsult: (payload: IpcConsultPayload, signal: AbortSignal) => Promise<IpcConsultResult>
  onLog?: (message: string) => void
}): Promise<IpcServerHandle> {
  const discoveryFile = getDiscoveryFilePath()
  const token = randomBytes(32).toString('hex')
  const mcpScriptPath = getMcpScriptPath()

  const server = http.createServer(async (req, res) => {
    const headerToken = typeof req.headers['x-advisor-token'] === 'string'
      ? req.headers['x-advisor-token']
      : ''

    if (!tokensEqual(headerToken, token)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized IPC token' })
      return
    }

    const urlPath = (req.url ?? '').split('?')[0]

    if (req.method === 'GET' && urlPath === '/v1/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, version: '0.1.0' })
      return
    }

    if (req.method === 'POST' && urlPath === '/v1/consult') {
      const ac = new AbortController()
      const onClose = () => {
        if (!res.writableFinished) ac.abort()
      }
      res.on('close', onClose)

      try {
        const payload = await readJsonBody(req)
        const result = await handlers.onConsult(payload, ac.signal)
        sendJson(res, 200, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, 400, { ok: false, advice: msg, error: msg })
      } finally {
        res.off('close', onClose)
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : null

  if (port !== null) {
    try {
      await fs.mkdir(path.dirname(discoveryFile), { recursive: true })
      const tmpFile = `${discoveryFile}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(
        tmpFile,
        JSON.stringify(
          {
            port,
            token,
            pid: process.pid,
            mcpScriptPath,
            startedAt: Date.now()
          },
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      )
      await fs.rename(tmpFile, discoveryFile)
    } catch (err) {
      handlers.onLog?.(
        `Failed to write IPC discovery file (${discoveryFile}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  let stopped = false

  return {
    get running() {
      return !stopped && server.listening
    },
    port,
    token,
    discoveryFile,
    async stop() {
      if (stopped) return
      stopped = true
      try {
        const raw = await fs.readFile(discoveryFile, 'utf8')
        const parsed = JSON.parse(raw) as { pid?: number; token?: string }
        if (parsed.pid === process.pid && parsed.token === token) {
          await fs.rm(discoveryFile, { force: true })
        }
      } catch {
        // discovery file missing or owned by newer worker
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}
