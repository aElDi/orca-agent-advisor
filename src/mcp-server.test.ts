import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { assert, describe, test } from 'orca/testing'
import { startIpcServer } from './ipc'

function createJsonRpcClient(ipcFile: string, extraEnv?: Record<string, string>) {
  const scriptPath = path.resolve(process.cwd(), 'src', 'mcp-server.mjs')
  const child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      AGENT_ADVISOR_IPC_FILE: ipcFile,
      ...extraEnv
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const pending = new Map<number, (msg: Record<string, unknown>) => void>()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof parsed.id === 'number') {
      const resolver = pending.get(parsed.id)
      if (resolver) {
        pending.delete(parsed.id)
        resolver(parsed)
      }
    }
  })

  let nextId = 1
  return {
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timeout waiting for ${method}`))
        }, 10_000)

        pending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })

        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    async close() {
      rl.close()
      child.stdin.end()
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        setTimeout(() => {
          child.kill()
          resolve()
        }, 1000)
      })
    }
  }
}

describe('mcp-server stdio + IPC bridge', () => {
  test('handles initialize, tools/list, and tools/call against worker IPC', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-mcp-'))
    const ipcFile = path.join(tmpDir, 'ipc.json')
    const prevEnv = process.env.AGENT_ADVISOR_IPC_FILE
    process.env.AGENT_ADVISOR_IPC_FILE = ipcFile

    let capturedPayload: Record<string, unknown> | null = null
    const ipc = await startIpcServer({
      async onConsult(payload) {
        capturedPayload = payload as Record<string, unknown>
        return {
          ok: true,
          advice: 'Use a lock per workspaceId.'
        }
      }
    })

    const client = createJsonRpcClient(ipcFile, {
      AGENT_ADVISOR_WORKSPACE_ID: 'ws-42',
      AGENT_ADVISOR_TERMINAL_ID: 'term-9',
      AGENT_ADVISOR_AGENT: 'codex'
    })

    try {
      const initRes = await client.request('initialize', { protocolVersion: '2025-03-26' })
      const initResult = initRes.result as Record<string, unknown>
      assert.equal(initResult.protocolVersion, '2025-03-26')

      const listRes = await client.request('tools/list')
      const listResult = listRes.result as { tools: { name: string; inputSchema: { required: string[] } }[] }
      assert.equal(listResult.tools.length, 1)
      assert.equal(listResult.tools[0].name, 'advisor')
      assert.deepEqual(listResult.tools[0].inputSchema.required, ['question'])

      const callRes = await client.request('tools/call', {
        name: 'advisor',
        arguments: {
          question: 'Should we queue per workspace?',
          files: ['src/advisor.ts'],
          includeDiff: false
        }
      })
      const callResult = callRes.result as { isError: boolean; content: { text: string }[] }
      assert.equal(callResult.isError, false)
      assert.equal(callResult.content[0].text, 'Use a lock per workspaceId.')

      assert.equal(capturedPayload?.['workspaceId'], 'ws-42')
      assert.equal(capturedPayload?.['terminalId'], 'term-9')
      assert.equal(capturedPayload?.['agent'], 'codex')
      assert.equal(capturedPayload?.['includeDiff'], false)
      assert.deepEqual(capturedPayload?.['files'], ['src/advisor.ts'])
    } finally {
      await client.close()
      await ipc.stop()
      if (prevEnv === undefined) delete process.env.AGENT_ADVISOR_IPC_FILE
      else process.env.AGENT_ADVISOR_IPC_FILE = prevEnv
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('returns clean error when worker IPC discovery file is absent', async () => {
    const missingIpc = path.join(os.tmpdir(), `missing-advisor-ipc-${Date.now()}.json`)
    const client = createJsonRpcClient(missingIpc)
    try {
      const callRes = await client.request('tools/call', {
        name: 'advisor',
        arguments: { question: 'Hello?' }
      })
      const callResult = callRes.result as { isError: boolean; content: { text: string }[] }
      assert.equal(callResult.isError, true)
      assert.match(callResult.content[0].text, /not running/i)
    } finally {
      await client.close()
    }
  })
})
