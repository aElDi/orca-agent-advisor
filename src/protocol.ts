import type {
  AdvisorLevel,
  ApiBackendId,
  BackendId,
  ConsultSource,
  ModelCatalogResult,
  SetupStatus,
  WorkspaceSnapshot
} from './types'

declare module 'orca' {
  interface PluginRequests {
    'advisor.getState': {
      input: { workspaceId?: string } | undefined
      output: WorkspaceSnapshot
    }
    'advisor.setEnabled': {
      input: { enabled: boolean }
      output: { enabled: boolean }
    }
    'advisor.setLevel': {
      input: { level: AdvisorLevel }
      output: { level: AdvisorLevel }
    }
    'advisor.selectProvider': {
      input: { backend: BackendId; orcaAgent?: string }
      output: { backend: BackendId; orcaAgent: string; model: string }
    }
    'advisor.startConsult': {
      input: {
        workspaceId?: string
        terminalId?: string
        question: string
        files?: string[]
        includeDiff?: boolean
        includeTerminal?: boolean
        source?: ConsultSource
      }
      output: { requestId: string }
    }
    'advisor.cancelConsult': {
      input: { requestId: string }
      output: { cancelled: boolean }
    }
    'advisor.injectToTerminal': {
      input: { terminalId: string; text: string; prefix?: string }
      output: { accepted: boolean }
    }
    'advisor.newThread': {
      input: { workspaceId?: string } | undefined
      output: { ok: true }
    }
    'advisor.resetBudget': {
      input: { workspaceId?: string } | undefined
      output: { ok: true }
    }
    'advisor.dismissAlerts': {
      input: { workspaceId?: string } | undefined
      output: { ok: true }
    }
    'advisor.saveApiKey': {
      input: { backend: ApiBackendId; apiKey: string }
      output: { ok: boolean; error?: string }
    }
    'advisor.deleteApiKey': {
      input: { backend: ApiBackendId }
      output: { ok: true }
    }
    'advisor.testConnection': {
      input: { backend?: BackendId; orcaAgent?: string; model?: string } | undefined
      output: { ok: boolean; latencyMs: number; model: string; message: string }
    }
    'advisor.listModels': {
      input: { backend?: BackendId; orcaAgent?: string; forceRefresh?: boolean } | undefined
      output: ModelCatalogResult
    }
    'advisor.selectBackend': {
      input: { backend: BackendId }
      output: { backend: BackendId; model: string }
    }
    'advisor.selectOrcaAgent': {
      input: { orcaAgent: string }
      output: { orcaAgent: string; model: string }
    }
    'advisor.selectModel': {
      input: { backend: BackendId; orcaAgent?: string; model: string }
      output: { ok: true }
    }
    'advisor.getSetupStatus': {
      input: { workspaceId?: string } | undefined
      output: SetupStatus
    }
    'advisor.installMcp': {
      input: {
        target: 'claude' | 'codex' | 'opencode' | 'workspace-mcp-json'
        workspaceId?: string
      }
      output: { ok: boolean; message: string }
    }
    'advisor.installSkill': {
      input: Record<string, never> | undefined
      output: { ok: boolean; path: string; message: string }
    }
  }

  interface PluginPanelEvents {
    'advisor.state': WorkspaceSnapshot
  }
}
