import { defineCheck } from 'orca/testing'
import {
  DEFAULT_SETTINGS,
  type ModelCatalogResult,
  type SetupStatus,
  type WorkspaceSnapshot
} from './types'

const baseStats = {
  totalCalls: 4,
  mcpCalls: 2,
  manualCalls: 1,
  autoReviewCalls: 1,
  totalInputTokens: 4200,
  totalOutputTokens: 980,
  totalCacheReadTokens: 1800,
  totalCostUsd: 0.042,
  loopAlerts: 1
}

const sampleEntries = [
  {
    id: 'entry-1',
    at: Date.now() - 180_000,
    source: 'mcp' as const,
    agent: 'opencode',
    question: 'Should we keep workspace advisor threads in memory or persist in orca.storage?',
    advice: 'Persist threads in `orca.storage` keyed by `workspaceId` so reloads preserve context.',
    backend: 'orca-agent' as const,
    model: 'codex / gpt-6.2-sol',
    latencyMs: 3120,
    usage: { inputTokens: 1900, outputTokens: 320, cacheReadTokens: 0 },
    context: {
      branch: 'feat/advisor',
      headSha: 'a1b2c3d',
      diffAdded: 0,
      diffRemoved: 0,
      diffFiles: 0,
      diffTruncated: false,
      filesIncluded: ['src/worker.ts'],
      filesSkipped: [],
      terminalLines: 0
    },
    verdict: null,
    orcaSessionId: 'sess-orca-1'
  },
  {
    id: 'entry-2',
    at: Date.now() - 45_000,
    source: 'auto-review' as const,
    agent: 'opencode',
    question: 'Review the current git diff.',
    advice: 'VERDICT: LGTM\n\nClean separation and bounded thread storage.',
    backend: 'orca-agent' as const,
    model: 'codex / gpt-6.2-sol',
    latencyMs: 2840,
    usage: { inputTokens: 2300, outputTokens: 290, cacheReadTokens: 1800 },
    context: {
      branch: 'feat/advisor',
      headSha: 'a1b2c3d',
      diffAdded: 84,
      diffRemoved: 12,
      diffFiles: 3,
      diffTruncated: false,
      filesIncluded: [],
      filesSkipped: [],
      terminalLines: 0
    },
    verdict: 'LGTM' as const,
    orcaSessionId: 'sess-orca-2'
  }
]

const installedOrcaAgents = [
  { id: 'opencode', name: 'OpenCode', default: true },
  { id: 'codex', name: 'Codex', default: false },
  { id: 'claude', name: 'Claude', default: false },
  { id: 'gemini', name: 'Gemini', default: false }
]

function makeSnapshot(overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  return {
    workspaceId: 'ws-1',
    displayName: 'orca-adviser-plugin',
    branch: 'feat/advisor',
    terminals: [{ id: 'term-1', title: 'OpenCode' }],
    installedOrcaAgents,
    autoSetup: {
      connectedAgents: ['Claude', 'Codex', 'OpenCode'],
      skillInstalled: true
    },
    thread: {
      workspaceId: 'ws-1',
      branch: 'feat/advisor',
      updatedAt: Date.now(),
      entries: sampleEntries,
      turnMcpUses: 2,
      reviewedDiffHashes: ['abcd1234']
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
    modelsByBackend: { 'orca-agent:codex': 'gpt-6.2-sol' },
    stats: baseStats,
    ...overrides
  }
}

const sampleModels: ModelCatalogResult = {
  backend: 'orca-agent',
  orcaAgent: 'codex',
  source: 'config',
  fetchedAt: Date.now(),
  note: 'Default "gpt-6.2-sol" from ~/.codex/config.toml',
  models: [
    { id: '', label: 'Default (gpt-6.2-sol)' },
    { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol (config.toml)' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'o3', label: 'o3' }
  ]
}

const sampleSetup: SetupStatus = {
  ipcRunning: true,
  ipcPort: 54321,
  ipcFile: 'C:/Users/demo/.orca-agent-advisor/ipc.json',
  mcpScriptPath: 'C:/Users/demo/orca-adviser-plugin/src/mcp-server.mjs',
  secretsProtection: 'os-keyring',
  savedKeys: { openrouter: true, anthropic: false, openai: false },
  agents: [],
  workspaceMcpJson: { path: 'C:/repo/.mcp.json', configured: false },
  globalSkill: { path: 'C:/Users/demo/.agents/skills/advisor/SKILL.md', installed: true },
  manualSnippetJson: '{}'
}

const baseResults = {
  'workspace.readContext': {
    workspaceId: 'ws-1',
    branch: 'feat/advisor',
    displayName: 'orca-adviser-plugin',
    terminals: [{ id: 'term-1', title: 'OpenCode' }]
  }
}

export default defineCheck({
  ready: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot({ thread: null }),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  },
  withAdvice: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot(),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  },
  paused: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot({
        settings: { ...DEFAULT_SETTINGS, enabled: false }
      }),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  },
  thinking: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot({
        activeRequest: {
          requestId: 'req-1',
          workspaceId: 'ws-1',
          source: 'mcp',
          agent: 'opencode',
          question: 'Check whether our IPC token check is safe against timing attacks.',
          startedAt: Date.now()
        }
      }),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  },
  loopAlert: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot({
        loopAlert: {
          terminalId: 'term-1',
          agent: 'opencode',
          tool: 'Bash',
          count: 3,
          lastInputSummary: '{"command":"npm test"}',
          at: Date.now()
        }
      }),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  },
  pendingReview: {
    results: baseResults,
    requests: {
      'advisor.getState': makeSnapshot({
        pendingReview: {
          workspaceId: 'ws-1',
          terminalId: 'term-1',
          diffHash: 'deadbeef',
          added: 120,
          removed: 18,
          files: 4,
          at: Date.now()
        }
      }),
      'advisor.getSetupStatus': sampleSetup,
      'advisor.listModels': sampleModels
    }
  }
})
