import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, assert, describe, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import * as main from './worker'

const execFileAsync = promisify(execFile)

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

function makeWorkspaceHost(wsPath: string, extra?: Parameters<typeof mockHost>[0]) {
  return mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'feat/advisor',
        displayName: 'Test Worktree',
        terminals: [{ id: 'term-1', title: 'Claude Code' }]
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'Test Worktree',
            path: wsPath,
            branch: 'feat/advisor',
            hostId: 'local'
          }
        ],
        truncated: false
      },
      'terminal.sendText': { accepted: true },
      'terminal.read': { lines: ['line 1', 'line 2'], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'secrets.protection': { status: 'os-keyring' },
      ...extra?.results
    },
    storage: extra?.storage,
    settings: {
      backend: 'claude-cli',
      maxUsesPerTurn: 2,
      loopDetectionEnabled: true,
      loopThreshold: 3,
      postFinishReviewMode: 'suggest',
      minDiffLinesForReview: 5,
      injectPromptGuidance: true,
      notifyOnAlerts: true,
      ...extra?.settings
    },
    secrets: extra?.secrets
  })
}

describe('agent-advisor worker', () => {
  test('returns state, manages secrets, injects to terminal, and resets budget', async () => {
    process.env.AGENT_ADVISOR_DISABLE_IPC = '1'
    const host = makeWorkspaceHost(process.cwd(), {
      storage: {
        'thread:ws-1': {
          workspaceId: 'ws-1',
          branch: 'feat/advisor',
          updatedAt: 1000,
          entries: [],
          turnMcpUses: 2,
          reviewedDiffHashes: []
        }
      }
    })

    activeWorker = await mountWorker(main, { host })
    const state = (await activeWorker.request('advisor.getState')) as {
      workspaceId: string
      branch: string
      thread: { turnMcpUses: number }
    }
    assert.equal(state.workspaceId, 'ws-1')
    assert.equal(state.branch, 'feat/advisor')
    assert.equal(state.thread.turnMcpUses, 2)

    await activeWorker.request('advisor.resetBudget')
    const afterReset = (await activeWorker.request('advisor.getState')) as {
      thread: { turnMcpUses: number }
    }
    assert.equal(afterReset.thread.turnMcpUses, 0)

    const saveRes = (await activeWorker.request('advisor.saveApiKey', {
      backend: 'openrouter',
      apiKey: 'sk-or-test-key'
    })) as { ok: boolean }
    assert.equal(saveRes.ok, true)
    assert.equal(host.data().secrets['apiKey:openrouter'], 'sk-or-test-key')

    const sendRes = (await activeWorker.request('advisor.injectToTerminal', {
      terminalId: 'term-1',
      text: 'Check edge case'
    })) as { accepted: boolean }
    assert.equal(sendRes.accepted, true)
    assert.equal(host.callsOf('terminal.sendText').length, 1)

    const toggleMsg = await activeWorker.command('advisor.toggleLoopDetector')
    assert.equal(toggleMsg, 'Loop detection disabled.')
    assert.equal(host.data().settings.loopDetectionEnabled, false)

    // advisor.open returns undefined so Orca never pops up a command output modal
    const openResult = await activeWorker.command('advisor.open')
    assert.equal(openResult, undefined)

    // Switch to native Orca Agent mode and verify per-agent model persistence
    await activeWorker.request('advisor.selectBackend', { backend: 'orca-agent' })
    assert.equal(host.data().settings.backend, 'orca-agent')

    const selectAgentRes = (await activeWorker.request('advisor.selectOrcaAgent', {
      orcaAgent: 'opencode'
    })) as { orcaAgent: string; model: string }
    assert.equal(selectAgentRes.orcaAgent, 'opencode')
    assert.equal(host.data().settings.orcaAgent, 'opencode')

    await activeWorker.request('advisor.selectModel', {
      backend: 'orca-agent',
      orcaAgent: 'opencode',
      model: 'openrouter/anthropic/claude-opus-4.6'
    })
    assert.equal(host.data().settings.model, 'openrouter/anthropic/claude-opus-4.6')

    await activeWorker.request('advisor.selectOrcaAgent', { orcaAgent: 'codex' })
    await activeWorker.request('advisor.selectModel', {
      backend: 'orca-agent',
      orcaAgent: 'codex',
      model: 'gpt-6.2-sol'
    })

    // Switching back to opencode restores its saved model automatically
    const backToOpenCode = (await activeWorker.request('advisor.selectProvider', {
      backend: 'orca-agent',
      orcaAgent: 'opencode'
    })) as { backend: string; orcaAgent: string; model: string }
    assert.equal(backToOpenCode.backend, 'orca-agent')
    assert.equal(backToOpenCode.orcaAgent, 'opencode')
    assert.equal(backToOpenCode.model, 'openrouter/anthropic/claude-opus-4.6')

    // Level presets apply bundled budget, loop threshold, diff review mode, and effort
    await activeWorker.request('advisor.setLevel', { level: 'frequent' })
    assert.equal(host.data().settings.advisorLevel, 'frequent')
    assert.equal(host.data().settings.maxUsesPerTurn, 8)
    assert.equal(host.data().settings.postFinishReviewMode, 'auto')
    assert.equal(host.data().settings.loopThreshold, 2)

    await activeWorker.request('advisor.setLevel', { level: 'rare' })
    assert.equal(host.data().settings.advisorLevel, 'rare')
    assert.equal(host.data().settings.maxUsesPerTurn, 2)
    assert.equal(host.data().settings.postFinishReviewMode, 'off')
    assert.equal(host.data().settings.loopThreshold, 4)

    assert.deepEqual(activeWorker.refusals, [])
  })

  test('setEnabled(false) pauses autonomous hooks and MCP consultations', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-paused-'))
    tempDirs.push(tmpDir)
    const ipcFile = path.join(tmpDir, 'ipc.json')
    process.env.AGENT_ADVISOR_IPC_FILE = ipcFile

    const host = makeWorkspaceHost(tmpDir, {
      settings: { enabled: true }
    })
    activeWorker = await mountWorker(main, { host })

    await activeWorker.request('advisor.setEnabled', { enabled: false })
    assert.equal(host.data().settings.enabled, false)

    // Prompt hook does not inject guidance while paused
    const promptDecision = await activeWorker.hooks.fire('agent.prompt.before', {
      agent: 'codex',
      terminalId: 'term-1',
      prompt: 'Fix bug',
      inputKind: 'orchestration'
    })
    assert.equal(promptDecision.kind, 'continue')
    if (promptDecision.kind === 'continue') {
      assert.equal(promptDecision.event.prompt, 'Fix bug')
    }

    // IPC MCP consult returns paused message without calling a provider
    const ipcInfo = JSON.parse(await fs.readFile(ipcFile, 'utf8')) as {
      port: number
      token: string
    }
    const res = await fetch(`http://127.0.0.1:${ipcInfo.port}/v1/consult`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-advisor-token': ipcInfo.token
      },
      body: JSON.stringify({
        question: 'Should I refactor?',
        cwd: tmpDir,
        workspaceId: 'ws-1'
      })
    })
    const data = (await res.json()) as { advice: string }
    assert.match(data.advice, /paused/i)
    assert.deepEqual(activeWorker.refusals, [])
  })

  test('hooks inject launch env, append prompt guidance, and detect loops', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-wtest-'))
    tempDirs.push(tmpDir)
    const ipcFile = path.join(tmpDir, 'ipc.json')
    process.env.AGENT_ADVISOR_IPC_FILE = ipcFile

    const host = makeWorkspaceHost(tmpDir)
    activeWorker = await mountWorker(main, { host })

    // 1. agent.launch.before injects env without changing command
    const launchDecision = await activeWorker.hooks.fire('agent.launch.before', {
      agent: 'codex',
      workspaceId: 'ws-1',
      workspaceKind: 'worktree',
      terminalId: 'term-1',
      command: 'codex',
      env: { EXISTING: '1' }
    })
    assert.equal(launchDecision.kind, 'continue')
    if (launchDecision.kind === 'continue') {
      assert.equal(launchDecision.event.command, 'codex')
      assert.equal(launchDecision.event.env.AGENT_ADVISOR_WORKSPACE_ID, 'ws-1')
      assert.equal(launchDecision.event.env.AGENT_ADVISOR_TERMINAL_ID, 'term-1')
      assert.equal(launchDecision.event.env.AGENT_ADVISOR_AGENT, 'codex')
      assert.equal(launchDecision.event.env.AGENT_ADVISOR_IPC_FILE, ipcFile)
      assert.equal(launchDecision.event.env.EXISTING, '1')
    }

    // 2. agent.prompt.before appends guidance unless already mentioned
    const promptDecision = await activeWorker.hooks.fire('agent.prompt.before', {
      agent: 'codex',
      terminalId: 'term-1',
      prompt: 'Implement feature X',
      inputKind: 'orchestration'
    })
    assert.equal(promptDecision.kind, 'continue')
    if (promptDecision.kind === 'continue') {
      assert.match(promptDecision.event.prompt, /advisor/)
    }

    const alreadyHasDecision = await activeWorker.hooks.fire('agent.prompt.before', {
      agent: 'codex',
      terminalId: 'term-1',
      prompt: 'Call advisor before editing',
      inputKind: 'driving'
    })
    if (alreadyHasDecision.kind === 'continue') {
      assert.equal(alreadyHasDecision.event.prompt, 'Call advisor before editing')
    }

    // 3. agent.tool.after loop detector fires after 3 identical failing calls
    for (let i = 0; i < 3; i++) {
      await activeWorker.hooks.fire('agent.tool.after', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-1',
        tool: 'Bash',
        input: { command: 'npm test' },
        output: { exitCode: 1 }
      })
    }

    const stateAfterLoop = (await activeWorker.request('advisor.getState')) as {
      loopAlert: { count: number; tool: string } | null
    }
    assert.equal(stateAfterLoop.loopAlert?.count, 3)
    assert.equal(stateAfterLoop.loopAlert?.tool, 'Bash')
    assert.ok(host.callsOf('notifications.show').length >= 1)
    assert.deepEqual(activeWorker.refusals, [])
  })

  test('agent.status.changed suggests review for large unreviewed diff and IPC enforces maxUsesPerTurn', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-wgit-'))
    tempDirs.push(tmpDir)
    const ipcFile = path.join(tmpDir, 'ipc.json')
    process.env.AGENT_ADVISOR_IPC_FILE = ipcFile

    await execFileAsync('git', ['init'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: tmpDir })
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const v = 1\n', 'utf8')
    await execFileAsync('git', ['add', 'index.ts'], { cwd: tmpDir })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    // Create a diff > 5 lines
    await fs.writeFile(
      path.join(tmpDir, 'index.ts'),
      Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
      'utf8'
    )

    const host = makeWorkspaceHost(tmpDir, {
      storage: {
        'thread:ws-1': {
          workspaceId: 'ws-1',
          branch: 'feat/advisor',
          updatedAt: 1000,
          entries: [],
          turnMcpUses: 1, // capped at maxUsesPerTurn: 1 below
          reviewedDiffHashes: []
        }
      },
      settings: {
        maxUsesPerTurn: 1,
        postFinishReviewMode: 'suggest',
        minDiffLinesForReview: 5
      }
    })

    activeWorker = await mountWorker(main, { host })

    // Verify IPC budget check when turnMcpUses >= maxUsesPerTurn
    const ipcInfo = JSON.parse(await fs.readFile(ipcFile, 'utf8')) as {
      port: number
      token: string
    }
    const ipcRes = await fetch(`http://127.0.0.1:${ipcInfo.port}/v1/consult`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-advisor-token': ipcInfo.token
      },
      body: JSON.stringify({
        question: 'Can I make another call?',
        cwd: tmpDir,
        workspaceId: 'ws-1'
      })
    })
    const ipcData = (await ipcRes.json()) as { budgetExceeded?: boolean; advice: string }
    assert.equal(ipcData.budgetExceeded, true)
    assert.match(ipcData.advice, /max_uses_exceeded/)

    // Now test turn lifecycle: working (resets turnMcpUses to 0) -> done (triggers pendingReview)
    await activeWorker.emit('agent.status.changed', {
      workspaceId: 'ws-1',
      paneKey: 'pane-1',
      terminalId: 'term-1',
      state: 'working',
      receivedAt: 10
    })

    await activeWorker.emit('agent.status.changed', {
      workspaceId: 'ws-1',
      paneKey: 'pane-1',
      terminalId: 'term-1',
      state: 'done',
      receivedAt: 20
    })

    const snap = (await activeWorker.request('advisor.getState')) as {
      pendingReview: { added: number; files: number } | null
      thread: { turnMcpUses: number }
    }
    assert.equal(snap.thread.turnMcpUses, 0)
    assert.ok(snap.pendingReview)
    assert.ok((snap.pendingReview?.added ?? 0) >= 9)
    assert.deepEqual(activeWorker.refusals, [])
  })
})
