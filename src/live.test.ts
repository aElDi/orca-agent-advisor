import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { afterEach, assert, describe, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import * as main from './worker'

const RUN_LIVE = process.env.ADVISOR_LIVE_E2E === '1'

let activeWorker: TestWorker | undefined
const tempDirs: string[] = []

afterEach(async () => {
  if (activeWorker) {
    await activeWorker.deactivate()
    activeWorker = undefined
  }
  delete process.env.AGENT_ADVISOR_IPC_FILE
  delete process.env.AGENT_ADVISOR_DISABLE_IPC
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('live end-to-end verification (set ADVISOR_LIVE_E2E=1 to run)', () => {
  test('fetches live model catalogs, verifies codex-cli & claude-cli, and completes MCP stdio round-trip', async () => {
    if (!RUN_LIVE) return

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-live-'))
    tempDirs.push(tmpDir)
    const ipcFile = path.join(tmpDir, 'ipc.json')
    process.env.AGENT_ADVISOR_IPC_FILE = ipcFile

    const host = mockHost({
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-live',
          branch: 'master',
          displayName: 'orca-adviser-plugin',
          terminals: [{ id: 'term-live', title: 'Codex' }]
        },
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-live',
              kind: 'worktree',
              name: 'orca-adviser-plugin',
              path: process.cwd(),
              branch: 'master',
              hostId: 'local'
            }
          ],
          truncated: false
        },
        'statusBar.update': { ok: true },
        'notifications.show': { delivered: true },
        'secrets.protection': { status: 'os-keyring' }
      },
      settings: {
        backend: 'codex-cli',
        model: '',
        reasoningEffort: 'low',
        maxUsesPerTurn: 4
      }
    })

    activeWorker = await mountWorker(main, { host })

    // 1. Live Orca installed agents + live model catalogs (including native orca-agent)
    const initialState = (await activeWorker.request('advisor.getState')) as {
      installedOrcaAgents: { id: string; name: string; default: boolean }[]
    }
    assert.ok(
      initialState.installedOrcaAgents.length >= 2,
      `Expected >=2 Orca agents, got ${JSON.stringify(initialState.installedOrcaAgents)}`
    )

    const orcaOpenCodeCat = (await activeWorker.request('advisor.listModels', {
      backend: 'orca-agent',
      orcaAgent: 'opencode',
      forceRefresh: true
    })) as { source: string; models: { id: string; label: string }[]; note?: string }
    assert.ok(orcaOpenCodeCat.models.length >= 5)

    const orcaCodexCat = (await activeWorker.request('advisor.listModels', {
      backend: 'orca-agent',
      orcaAgent: 'codex',
      forceRefresh: true
    })) as { source: string; models: { id: string; label: string }[]; note?: string }
    assert.ok(orcaCodexCat.models.length >= 2)

    const codexCat = (await activeWorker.request('advisor.listModels', {
      backend: 'codex-cli',
      forceRefresh: true
    })) as { source: string; models: { id: string; label: string }[]; note?: string }
    assert.ok(codexCat.models.length >= 2)

    const claudeCat = (await activeWorker.request('advisor.listModels', {
      backend: 'claude-cli',
      forceRefresh: true
    })) as { source: string; models: { id: string; label: string }[]; note?: string }
    assert.ok(claudeCat.models.length >= 4)

    const orCat = (await activeWorker.request('advisor.listModels', {
      backend: 'openrouter',
      forceRefresh: true
    })) as { source: string; models: { id: string; label: string }[]; note?: string }
    assert.ok(orCat.models.length >= 6)

    // 2. Live connection tests
    const codexTest = (await activeWorker.request('advisor.testConnection', {
      backend: 'codex-cli'
    })) as { ok: boolean; model: string; latencyMs: number; message: string }
    assert.equal(codexTest.ok, true, `codex-cli failed: ${codexTest.message}`)

    const claudeModel =
      claudeCat.models.find((m) => m.id === 'gpt-5.5')?.id ??
      claudeCat.models.find((m) => m.id !== '' && m.id !== 'opus')?.id ??
      ''
    const claudeTest = (await activeWorker.request('advisor.testConnection', {
      backend: 'claude-cli',
      ...(claudeModel ? { model: claudeModel } : {})
    })) as { ok: boolean; model: string; latencyMs: number; message: string }
    assert.equal(claudeTest.ok, true, `claude-cli failed: ${claudeTest.message}`)

    // 3. Live stdio MCP -> Worker IPC -> Codex CLI consultation
    const child = spawn(process.execPath, [path.resolve('src', 'mcp-server.mjs')], {
      env: {
        ...process.env,
        AGENT_ADVISOR_IPC_FILE: ipcFile,
        AGENT_ADVISOR_WORKSPACE_ID: 'ws-live',
        AGENT_ADVISOR_AGENT: 'codex'
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    const sendRpc = (obj: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP RPC timeout')), 60_000)
        const onLine = (line: string) => {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.id === obj.id) {
            clearTimeout(timer)
            rl.off('line', onLine)
            resolve(parsed)
          }
        }
        rl.on('line', onLine)
        child.stdin.write(JSON.stringify(obj) + '\n')
      })

    try {
      await sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
      const callRes = await sendRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'advisor',
          arguments: {
            question: 'Reply with exactly OK.',
            includeDiff: false
          }
        }
      })
      const result = callRes.result as { isError: boolean; content: { text: string }[] }
      assert.equal(result.isError, false, `MCP call errored: ${JSON.stringify(result)}`)
      assert.match(result.content[0].text, /OK/i)

      const state = (await activeWorker.request('advisor.getState')) as {
        thread: { entries: { source: string; advice: string; model: string }[]; turnMcpUses: number }
      }
      assert.equal(state.thread.turnMcpUses, 1)
      assert.equal(state.thread.entries.length, 1)
      assert.equal(state.thread.entries[0].source, 'mcp')

      console.error(
        `[LIVE E2E OK] orcaAgents=${initialState.installedOrcaAgents.length} | catalogs: orca/opencode=${orcaOpenCodeCat.models.length}(${orcaOpenCodeCat.source}) orca/codex=${orcaCodexCat.models.length}(${orcaCodexCat.source}) codex=${codexCat.models.length}(${codexCat.source}) claude=${claudeCat.models.length}(${claudeCat.source}) openrouter=${orCat.models.length}(${orCat.source}) | codex=${codexTest.model}(${codexTest.latencyMs}ms) | claude=${claudeTest.model}(${claudeTest.latencyMs}ms) | mcp_reply="${result.content[0].text.trim().slice(0, 40)}"`
      )
    } finally {
      rl.close()
      child.stdin.end()
      child.kill()
    }

    assert.deepEqual(activeWorker.refusals, [])
  })
})
