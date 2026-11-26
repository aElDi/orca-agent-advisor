import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'
import {
  DEFAULT_SETTINGS,
  type AdvisorLevel,
  type ModelCatalogResult,
  type SetupStatus,
  type WorkspaceSnapshot
} from './types'

let mounted: TestPanel | undefined

afterEach(async () => {
  if (mounted) {
    await mounted.unmount()
    mounted = undefined
  }
})

const installedOrcaAgents = [
  { id: 'opencode', name: 'OpenCode', default: true },
  { id: 'codex', name: 'Codex', default: false },
  { id: 'claude', name: 'Claude', default: false }
]

function makeSnapshot(overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  return {
    workspaceId: 'ws-1',
    displayName: 'Demo Workspace',
    branch: 'main',
    terminals: [{ id: 'term-1', title: 'OpenCode' }],
    installedOrcaAgents,
    autoSetup: {
      connectedAgents: ['Claude', 'Codex', 'OpenCode'],
      skillInstalled: true
    },
    thread: {
      workspaceId: 'ws-1',
      branch: 'main',
      updatedAt: 1000,
      entries: [],
      turnMcpUses: 1,
      reviewedDiffHashes: []
    },
    activeRequest: null,
    loopAlert: null,
    pendingReview: null,
    lastError: null,
    settings: {
      ...DEFAULT_SETTINGS,
      backend: 'orca-agent',
      orcaAgent: 'codex',
      advisorLevel: 'balanced',
      enabled: true
    },
    modelsByBackend: {},
    stats: {
      totalCalls: 1,
      mcpCalls: 1,
      manualCalls: 0,
      autoReviewCalls: 0,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 0,
      totalCostUsd: 0,
      loopAlerts: 0
    },
    ...overrides
  }
}

const mockSetup: SetupStatus = {
  ipcRunning: true,
  ipcPort: 41234,
  ipcFile: 'C:/tmp/ipc.json',
  mcpScriptPath: 'C:/tmp/mcp-server.mjs',
  secretsProtection: 'os-keyring',
  savedKeys: { openrouter: false, anthropic: false, openai: false },
  agents: [],
  workspaceMcpJson: { path: 'C:/tmp/.mcp.json', configured: false },
  globalSkill: { path: 'C:/tmp/SKILL.md', installed: true },
  manualSnippetJson: '{}'
}

const mockCatalog: ModelCatalogResult = {
  backend: 'orca-agent',
  orcaAgent: 'codex',
  source: 'config',
  fetchedAt: Date.now(),
  note: 'From ~/.codex/config.toml',
  models: [
    { id: '', label: 'Default (gpt-6.2-sol)' },
    { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol (config.toml)' },
    { id: 'o3', label: 'o3' }
  ]
}

describe('agent-advisor minimal panel', () => {
  test('toggles on/off, switches unified provider + model, selects advisor level, and shows live auto-setup', async () => {
    const captured = {
      enabled: null as boolean | null,
      provider: null as { backend: string; orcaAgent?: string } | null,
      model: null as string | null,
      level: null as AdvisorLevel | null
    }
    let currentSnap = makeSnapshot()

    const host = mockHost({
      requests: {
        'advisor.getState': () => currentSnap,
        'advisor.getSetupStatus': () => mockSetup,
        'advisor.listModels': (input) => ({
          ...mockCatalog,
          backend: (input?.backend ?? currentSnap.settings.backend) as ModelCatalogResult['backend'],
          orcaAgent: (input?.orcaAgent ?? currentSnap.settings.orcaAgent) as string
        }),
        'advisor.setEnabled': (input) => {
          captured.enabled = input.enabled
          currentSnap = {
            ...currentSnap,
            settings: { ...currentSnap.settings, enabled: input.enabled }
          }
          return { enabled: input.enabled }
        },
        'advisor.selectProvider': (input) => {
          captured.provider = input
          currentSnap = {
            ...currentSnap,
            settings: {
              ...currentSnap.settings,
              backend: input.backend,
              orcaAgent: input.orcaAgent ?? currentSnap.settings.orcaAgent,
              model: ''
            }
          }
          return {
            backend: input.backend,
            orcaAgent: input.orcaAgent ?? currentSnap.settings.orcaAgent,
            model: ''
          }
        },
        'advisor.selectModel': (input) => {
          captured.model = input.model
          currentSnap = {
            ...currentSnap,
            settings: { ...currentSnap.settings, model: input.model }
          }
          return { ok: true as const }
        },
        'advisor.setLevel': (input) => {
          captured.level = input.level
          currentSnap = {
            ...currentSnap,
            settings: { ...currentSnap.settings, advisorLevel: input.level }
          }
          return { level: input.level }
        }
      }
    })

    mounted = await mount(panelModule, { host, locale: 'en-US' })
    assert.ok(mounted.find({ text: 'Active' }))

    // Change model
    await mounted.select({ label: 'Model' }, 'o3')
    assert.equal(captured.model, 'o3')

    // Change thinking / effort directly
    await mounted.select({ label: 'Thinking / Effort' }, 'xhigh')
    assert.equal(host.data().settings.reasoningEffort, 'xhigh')

    // Change provider (Orca agent)
    await mounted.select({ label: 'Provider' }, 'orca:opencode')
    assert.equal(captured.provider?.backend, 'orca-agent')
    assert.equal(captured.provider?.orcaAgent, 'opencode')

    // Change advisor level preset
    await mounted.select({ label: 'Advisor level' }, 'frequent')
    assert.equal(captured.level, 'frequent')

    // Toggle On/Off switch
    await mounted.toggle({ label: 'On' })
    assert.equal(captured.enabled, false)
    assert.ok(mounted.find({ text: 'Off' }))

    assert.deepEqual(mounted.errors, [])
    assert.deepEqual(mounted.warnings, [])
    assert.deepEqual(mounted.refusals, [])
  })

  test('renders localized Russian minimal UI with Редко / Средне / Часто', async () => {
    const host = mockHost({
      requests: {
        'advisor.getState': () => makeSnapshot(),
        'advisor.getSetupStatus': () => mockSetup,
        'advisor.listModels': () => mockCatalog
      }
    })

    mounted = await mount(panelModule, { host, locale: 'ru-RU' })
    assert.ok(mounted.find({ text: 'Активен' }))
    assert.ok(mounted.find({ label: 'Провайдер' }))
    assert.ok(mounted.find({ label: 'Модель' }))
    assert.ok(mounted.find({ label: 'Рассуждения (Effort)' }))
    assert.ok(mounted.find({ label: 'Уровень советчика' }))
    assert.deepEqual(mounted.errors, [])
    assert.deepEqual(mounted.warnings, [])
    assert.deepEqual(mounted.refusals, [])
  })
})
