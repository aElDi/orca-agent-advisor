import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  env,
  Heading,
  IconButton,
  Image,
  Input,
  Markdown,
  on,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  settings,
  Spinner,
  Stack,
  Switch,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import { getStrings } from './i18n'
import './protocol'
import {
  BACKEND_LABELS,
  DEFAULT_SETTINGS,
  isApiBackend,
  resolveEffectiveModel,
  type AdvisorLevel,
  type ApiBackendId,
  type BackendId,
  type ModelCatalogResult,
  type ReasoningEffort,
  type SetupStatus,
  type ThreadEntry,
  type WorkspaceSnapshot
} from './types'

const DEFAULT_MODEL_SENTINEL = '__default__'
const CUSTOM_MODEL_SENTINEL = '__custom__'

const snapshotAtom = atom<WorkspaceSnapshot | null>('snapshot', null)
const setupAtom = atom<SetupStatus | null>('setup', null)
const modelCatalogAtom = atom<ModelCatalogResult | null>('modelCatalog', null)
const modelsLoadingAtom = atom('modelsLoading', false)
const loadErrorAtom = atom<string | null>('loadError', null)

const modelFilterAtom = atom('modelFilter', '')
const customModelModeAtom = atom('customModelMode', false)
const customModelDraftAtom = atom('customModelDraft', '')
const apiKeyDraftAtom = atom('apiKeyDraft', '')
const busyAtom = atom<string | null>('busy', null)
const feedbackAtom = atom<{ tone: Tone; text: string } | null>('feedback', null)

let lastCatalogKey = ''

function encodeProvider(backend: BackendId, orcaAgent: string): string {
  if (backend === 'orca-agent') return `orca:${orcaAgent || 'codex'}`
  return `direct:${backend}`
}

function decodeProvider(value: string): { backend: BackendId; orcaAgent?: string } {
  if (value.startsWith('orca:')) {
    return { backend: 'orca-agent', orcaAgent: value.slice(5) || 'codex' }
  }
  const raw = value.startsWith('direct:') ? value.slice(7) : value
  const backend: BackendId =
    raw === 'codex-cli' ||
    raw === 'claude-cli' ||
    raw === 'openrouter' ||
    raw === 'anthropic' ||
    raw === 'openai'
      ? raw
      : 'orca-agent'
  return { backend }
}

function catalogKeyFor(backend: BackendId, orcaAgent?: string): string {
  return backend === 'orca-agent' ? `orca-agent:${orcaAgent || 'codex'}` : backend
}

async function refreshModels(
  backend: BackendId,
  orcaAgent?: string,
  forceRefresh = false
): Promise<void> {
  const key = catalogKeyFor(backend, orcaAgent)
  lastCatalogKey = key
  set(modelsLoadingAtom, true)
  try {
    const res = await plugin.request(
      'advisor.listModels',
      {
        backend,
        ...(backend === 'orca-agent' && orcaAgent ? { orcaAgent } : {}),
        forceRefresh
      },
      { timeoutMs: 20_000 }
    )
    if (lastCatalogKey === key) {
      set(modelCatalogAtom, res)
    }
  } catch {
    // keep previous catalog if refresh fails
  } finally {
    if (lastCatalogKey === key) {
      set(modelsLoadingAtom, false)
    }
  }
}

async function refreshSetup(): Promise<void> {
  try {
    const status = await plugin.request('advisor.getSetupStatus', undefined, { timeoutMs: 10_000 })
    set(setupAtom, status)
  } catch {
    // non-fatal
  }
}

async function refreshState(): Promise<WorkspaceSnapshot | null> {
  try {
    const snap = await plugin.request('advisor.getState', undefined, { timeoutMs: 15_000 })
    set(loadErrorAtom, null)
    set(snapshotAtom, snap)

    const nextKey = catalogKeyFor(snap.settings.backend, snap.settings.orcaAgent)
    if (nextKey !== lastCatalogKey) {
      void refreshModels(snap.settings.backend, snap.settings.orcaAgent, false)
    }
    return snap
  } catch (err) {
    set(loadErrorAtom, err instanceof Error ? err.message : 'Failed to load Advisor state.')
    return null
  }
}

async function refreshAll(): Promise<void> {
  const snap = await refreshState()
  if (snap) {
    if (isApiBackend(snap.settings.backend)) {
      void refreshSetup()
    }
    if (!lastCatalogKey) {
      void refreshModels(snap.settings.backend, snap.settings.orcaAgent, false)
    }
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('advisor.state', (snap) => {
      set(loadErrorAtom, null)
      set(snapshotAtom, snap)
      const nextKey = catalogKeyFor(snap.settings.backend, snap.settings.orcaAgent)
      if (nextKey !== lastCatalogKey) {
        void refreshModels(snap.settings.backend, snap.settings.orcaAgent, false)
      }
    }),
    on('workspace.changed', () => {
      void refreshState()
    })
  )

  void refreshAll()
}

async function toggleEnabled(enabled: boolean): Promise<void> {
  set(feedbackAtom, null)
  try {
    await plugin.request('advisor.setEnabled', { enabled })
    await refreshState()
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Failed to update status.'
    })
  }
}

async function selectProvider(encoded: string): Promise<void> {
  const { backend, orcaAgent } = decodeProvider(encoded)
  set(feedbackAtom, null)
  set(modelFilterAtom, '')
  set(customModelModeAtom, false)
  try {
    await plugin.request('advisor.selectProvider', {
      backend,
      ...(orcaAgent ? { orcaAgent } : {})
    })
    const snap = await refreshState()
    if (isApiBackend(backend)) {
      void refreshSetup()
    }
    await refreshModels(backend, orcaAgent ?? snap?.settings.orcaAgent, false)
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Failed to switch provider.'
    })
  }
}

async function selectModel(backend: BackendId, model: string, orcaAgent?: string): Promise<void> {
  set(feedbackAtom, null)
  try {
    await plugin.request('advisor.selectModel', {
      backend,
      ...(backend === 'orca-agent' && orcaAgent ? { orcaAgent } : {}),
      model
    })
    set(customModelModeAtom, false)
    await refreshState()
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Failed to update model.'
    })
  }
}

async function selectLevel(level: AdvisorLevel): Promise<void> {
  set(feedbackAtom, null)
  try {
    await plugin.request('advisor.setLevel', { level })
    await refreshState()
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Failed to update level.'
    })
  }
}

async function selectEffort(effort: ReasoningEffort): Promise<void> {
  set(feedbackAtom, null)
  try {
    await settings.set('reasoningEffort', effort)
    await refreshState()
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Failed to update reasoning effort.'
    })
  }
}

async function saveApiKey(backend: ApiBackendId): Promise<void> {
  const key = read(apiKeyDraftAtom).trim()
  if (!key) return
  set(busyAtom, 'saveKey')
  try {
    const res = await plugin.request('advisor.saveApiKey', { backend, apiKey: key })
    if (res.ok) {
      set(apiKeyDraftAtom, '')
      await Promise.all([refreshSetup(), refreshModels(backend, undefined, true)])
    } else {
      set(feedbackAtom, { tone: 'danger', text: res.error ?? 'Could not save API key.' })
    }
  } finally {
    set(busyAtom, null)
  }
}

async function cancelActive(): Promise<void> {
  const active = read(snapshotAtom)?.activeRequest
  if (!active) return
  await plugin.request('advisor.cancelConsult', { requestId: active.requestId }).catch(() => undefined)
}

async function runQuickAction(
  question: string,
  source: 'unstick' | 'auto-review'
): Promise<void> {
  const snap = read(snapshotAtom)
  if (!snap?.workspaceId) return
  const terminalId = snap.terminals[0]?.id
  set(busyAtom, source)
  try {
    await plugin.request('advisor.startConsult', {
      workspaceId: snap.workspaceId,
      ...(terminalId ? { terminalId } : {}),
      question,
      includeDiff: true,
      includeTerminal: source === 'unstick',
      source
    })
    await refreshState()
  } catch (err) {
    set(feedbackAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : 'Consultation failed.'
    })
  } finally {
    set(busyAtom, null)
  }
}

async function dismissAlerts(): Promise<void> {
  const wsId = read(snapshotAtom)?.workspaceId
  await plugin.request('advisor.dismissAlerts', wsId ? { workspaceId: wsId } : undefined)
  await refreshState()
}

async function injectAdvice(entry: ThreadEntry): Promise<void> {
  const terminalId = read(snapshotAtom)?.terminals[0]?.id
  if (!terminalId) return
  set(busyAtom, `inject:${entry.id}`)
  try {
    await plugin.request('advisor.injectToTerminal', {
      terminalId,
      text: entry.advice
    })
  } finally {
    set(busyAtom, null)
  }
}

function clipText(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n...`
}

export default function Panel() {
  const t = getStrings(env.locale)
  const snap = read(snapshotAtom)
  const setupStatus = read(setupAtom)
  const catalog = read(modelCatalogAtom)
  const modelsLoading = read(modelsLoadingAtom)
  const loadError = read(loadErrorAtom)
  const feedback = read(feedbackAtom)
  const busy = read(busyAtom)

  const settingsVal = snap?.settings ?? DEFAULT_SETTINGS
  const enabled = settingsVal.enabled
  const backend = settingsVal.backend
  const orcaAgent = settingsVal.orcaAgent
  const level = settingsVal.advisorLevel
  const currentModel = resolveEffectiveModel(settingsVal)
  const apiBackend: ApiBackendId | null = isApiBackend(backend) ? backend : null

  // Build unified Provider dropdown: all Orca-installed agents + optional APIs
  const installedOrca = snap?.installedOrcaAgents ?? []
  const orcaProviders =
    installedOrca.length > 0
      ? installedOrca.map((a) => ({
          value: `orca:${a.id}`,
          label: a.default ? `${a.name} (Orca)` : a.name
        }))
      : [
          { value: 'orca:codex', label: 'Codex' },
          { value: 'orca:claude', label: 'Claude' },
          { value: 'orca:opencode', label: 'OpenCode' },
          { value: 'orca:gemini', label: 'Gemini' },
          { value: 'orca:antigravity', label: 'Antigravity' },
          { value: 'orca:grok', label: 'Grok' }
        ]

  const providerOptions: { value: string; label: string }[] = [
    ...orcaProviders,
    { value: 'direct:openrouter', label: 'OpenRouter API' },
    { value: 'direct:anthropic', label: 'Anthropic API' },
    { value: 'direct:openai', label: 'OpenAI / Compatible API' }
  ]

  const currentProviderVal = encodeProvider(backend, orcaAgent)
  if (!providerOptions.some((o) => o.value === currentProviderVal)) {
    providerOptions.unshift({
      value: currentProviderVal,
      label: backend === 'orca-agent' ? orcaAgent : BACKEND_LABELS[backend]
    })
  }

  // Model catalog matching current provider
  const matchingCatalog =
    catalog &&
    catalog.backend === backend &&
    (backend !== 'orca-agent' || catalog.orcaAgent === orcaAgent)
      ? catalog
      : null

  const rawModels = matchingCatalog?.models ?? []
  const filterQuery = read(modelFilterAtom).trim().toLowerCase()
  const filteredModels = filterQuery
    ? rawModels.filter(
        (m) =>
          m.id.toLowerCase().includes(filterQuery) ||
          m.label.toLowerCase().includes(filterQuery)
      )
    : rawModels

  const encodeModel = (id: string) => (id === '' ? DEFAULT_MODEL_SENTINEL : id)
  const decodeModel = (val: string) => (val === DEFAULT_MODEL_SENTINEL ? '' : val)

  const modelOptions: { value: string; label: string }[] = filteredModels.slice(0, 200).map((m) => ({
    value: encodeModel(m.id),
    label: m.label
  }))

  const encodedCurrentModel = encodeModel(currentModel)
  const inOptions = modelOptions.some((o) => o.value === encodedCurrentModel)
  if (currentModel !== '' && !inOptions && !read(customModelModeAtom)) {
    modelOptions.unshift({ value: encodedCurrentModel, label: currentModel })
  }
  if (modelOptions.length === 0) {
    modelOptions.push({ value: DEFAULT_MODEL_SENTINEL, label: currentModel || 'Default' })
  }
  modelOptions.push({ value: CUSTOM_MODEL_SENTINEL, label: t.customModelOption })

  const selectModelValue = read(customModelModeAtom)
    ? CUSTOM_MODEL_SENTINEL
    : modelOptions.some((o) => o.value === encodedCurrentModel)
      ? encodedCurrentModel
      : modelOptions[0].value

  const needsApiKey =
    apiBackend === 'openrouter'
      ? setupStatus !== null && !setupStatus.savedKeys.openrouter
      : apiBackend === 'anthropic'
        ? setupStatus !== null && !setupStatus.savedKeys.anthropic
        : apiBackend === 'openai'
          ? setupStatus !== null && !setupStatus.savedKeys.openai && !settingsVal.customBaseUrl
          : false

  const active = snap?.activeRequest ?? null
  const entries = snap?.thread?.entries ?? []
  const newestEntries = [...entries].reverse().slice(0, 8)

  const headerStatus = active
    ? t.statusConsulting(
        active.agent || 'Agent',
        backend === 'orca-agent' ? orcaAgent : BACKEND_LABELS[backend]
      )
    : enabled
      ? t.statusActive
      : t.statusPaused

  const effortOptions: { value: ReasoningEffort; label: string }[] = [
    { value: 'default', label: t.effortDefault },
    { value: 'low', label: t.effortLow },
    { value: 'medium', label: t.effortMedium },
    { value: 'high', label: t.effortHigh },
    { value: 'xhigh', label: t.effortXHigh },
    ...(backend === 'claude-cli' || (backend === 'orca-agent' && orcaAgent === 'claude')
      ? [{ value: 'max' as const, label: t.effortMax }]
      : [])
  ]

  const friendlyLoadError = loadError
    ? /changed or is no longer approved/i.test(loadError)
      ? t.reapproveHint
      : loadError
    : null

  return (
    <Stack gap="md">
      {/* 1. Header: icon + title + status + master On/Off switch */}
      <Row justify="between" align="center" gap="sm">
        <Row gap="sm" align="center">
          <Image src="assets/mark.png" alt="" size="xs" />
          <Stack gap="none">
            <Heading level={3}>Advisor</Heading>
            <Text size="xs" tone={active ? 'accent' : 'neutral'} muted={!active} truncate>
              {headerStatus}
            </Text>
          </Stack>
        </Row>

        <Switch
          label={t.enabledLabel}
          checked={enabled}
          onChange={(checked) => {
            void toggleEnabled(checked)
          }}
        />
      </Row>

      {friendlyLoadError ? (
        <Callout tone="warning" icon="warning">
          <Row justify="between" align="center" gap="xs">
            <Text size="xs">{friendlyLoadError}</Text>
            <Button size="xs" variant="outline" onPress={refreshAll}>
              {t.retryBtn}
            </Button>
          </Row>
        </Callout>
      ) : null}

      {feedback ? (
        <Callout tone={feedback.tone} icon="info">
          <Row justify="between" align="center" gap="xs">
            <Text size="xs">{feedback.text}</Text>
            <IconButton
              icon="close"
              label={t.dismissBtn}
              size="xs"
              variant="ghost"
              onPress={() => set(feedbackAtom, null)}
            />
          </Row>
        </Callout>
      ) : null}

      <Separator />

      {/* 2. Provider & Model (auto-populated from Orca agents / live catalogs) */}
      <Stack gap="sm">
        <Select
          label={t.providerLabel}
          value={currentProviderVal}
          options={providerOptions}
          disabled={!enabled}
          onChange={(val) => {
            void selectProvider(val)
          }}
        />

        {rawModels.length > 12 ? (
          <Input
            label={t.modelSearchLabel}
            labelHidden
            type="search"
            placeholder={t.modelSearchPlaceholder}
            value={read(modelFilterAtom)}
            disabled={!enabled}
            onChange={(val) => set(modelFilterAtom, val)}
          />
        ) : null}

        <Row gap="xs" align="end">
          {modelsLoading && !matchingCatalog ? (
            <Spinner label={t.loadingModels} />
          ) : (
            <Select
              label={t.modelLabel}
              value={selectModelValue}
              options={modelOptions}
              disabled={!enabled}
              onChange={(val) => {
                if (val === CUSTOM_MODEL_SENTINEL) {
                  set(customModelModeAtom, true)
                  set(customModelDraftAtom, currentModel)
                } else {
                  void selectModel(
                    backend,
                    decodeModel(val),
                    backend === 'orca-agent' ? orcaAgent : undefined
                  )
                }
              }}
            />
          )}
          <IconButton
            icon="refresh"
            label={t.refreshModelsTooltip}
            tooltip={t.refreshModelsTooltip}
            variant="ghost"
            size="sm"
            disabled={!enabled || modelsLoading}
            onPress={() => refreshModels(backend, orcaAgent, true)}
          />
        </Row>

        <Select
          label={t.effortLabel}
          value={settingsVal.reasoningEffort}
          options={effortOptions}
          disabled={!enabled}
          onChange={(val) => {
            void selectEffort(val as ReasoningEffort)
          }}
        />

        {read(customModelModeAtom) ? (
          <Row gap="xs" align="center">
            <Input
              label={t.customModelOption}
              labelHidden
              placeholder={t.customModelPlaceholder}
              value={read(customModelDraftAtom)}
              onChange={(val) => set(customModelDraftAtom, val)}
              onSubmit={(val) => {
                void selectModel(backend, val, backend === 'orca-agent' ? orcaAgent : undefined)
              }}
            />
            <Button
              size="xs"
              tone="accent"
              onPress={() =>
                selectModel(
                  backend,
                  read(customModelDraftAtom),
                  backend === 'orca-agent' ? orcaAgent : undefined
                )
              }
            >
              {t.applyBtn}
            </Button>
            <Button size="xs" variant="ghost" onPress={() => set(customModelModeAtom, false)}>
              {t.cancelBtn}
            </Button>
          </Row>
        ) : null}

        {apiBackend && needsApiKey ? (
          <Row gap="xs" align="end">
            <Input
              label={t.apiKeyLabel}
              type="password"
              placeholder={t.apiKeyPlaceholder}
              value={read(apiKeyDraftAtom)}
              onChange={(val) => set(apiKeyDraftAtom, val)}
              onSubmit={() => {
                void saveApiKey(apiBackend)
              }}
            />
            <Button
              size="xs"
              tone="accent"
              disabled={busy === 'saveKey'}
              onPress={() => saveApiKey(apiBackend)}
            >
              {t.saveKeyBtn}
            </Button>
          </Row>
        ) : null}
      </Stack>

      <Separator />

      {/* 3. Advisor level presets (Rare / Balanced / Frequent — popover style) */}
      <RadioGroup
        label={t.levelLabel}
        value={level}
        orientation="vertical"
        disabled={!enabled}
        options={[
          { value: 'rare', label: t.levelRare, description: t.levelRareDesc },
          { value: 'balanced', label: t.levelBalanced, description: t.levelBalancedDesc },
          { value: 'frequent', label: t.levelFrequent, description: t.levelFrequentDesc }
        ]}
        onChange={(val) => {
          void selectLevel(val as AdvisorLevel)
        }}
      />

      {/* 4. Contextual live status (only visible when active / alert / recent advice) */}
      {active ? (
        <Box background="card" border="accent" radius="md" padding="sm" gap="xs">
          <Row justify="between" align="center" gap="xs">
            <Row gap="xs" align="center">
              <Spinner label={t.thinkingLabel} labelHidden />
              <Text size="xs" tone="accent" weight="medium">
                {t.thinkingLabel}
              </Text>
            </Row>
            <Button size="xs" variant="outline" onPress={cancelActive}>
              {t.cancelBtn}
            </Button>
          </Row>
          <Text size="xs" muted truncate>
            {active.question}
          </Text>
        </Box>
      ) : null}

      {snap?.loopAlert ? (
        <Callout
          tone="warning"
          title={t.loopTitle(snap.loopAlert.count, snap.loopAlert.tool)}
          icon="warning"
        >
          <Row gap="xs" wrap>
            <Button
              size="xs"
              tone="warning"
              disabled={busy === 'unstick'}
              onPress={() =>
                runQuickAction(
                  `The executor agent (${snap.loopAlert?.agent}) repeated "${snap.loopAlert?.tool}" ${snap.loopAlert?.count} times (${snap.loopAlert?.lastInputSummary}). Diagnose the root cause and provide a concise fix.`,
                  'unstick'
                )
              }
            >
              {t.unstickBtn}
            </Button>
            <Button size="xs" variant="ghost" onPress={dismissAlerts}>
              {t.dismissBtn}
            </Button>
          </Row>
        </Callout>
      ) : null}

      {snap?.pendingReview ? (
        <Callout
          tone="accent"
          title={t.pendingDiffTitle(snap.pendingReview.added, snap.pendingReview.removed)}
          icon="code"
        >
          <Row gap="xs" wrap>
            <Button
              size="xs"
              tone="accent"
              disabled={busy === 'auto-review'}
              onPress={() =>
                runQuickAction(
                  'Review the current git diff for bugs, regressions, and edge cases. Start with VERDICT: LGTM or VERDICT: CHANGES_REQUESTED.',
                  'auto-review'
                )
              }
            >
              {t.reviewNowBtn}
            </Button>
            <Button size="xs" variant="ghost" onPress={dismissAlerts}>
              {t.dismissBtn}
            </Button>
          </Row>
        </Callout>
      ) : null}

      {newestEntries.length > 0 ? (
        <Collapsible title={t.recentHeading(entries.length)}>
          <Stack gap="sm">
            {newestEntries.map((entry) => (
              <Stack key={entry.id} gap="xs">
                <Row justify="between" align="center" gap="xs">
                  <Row gap="xs" align="center">
                    <Text size="xs" weight="semibold">
                      {`${entry.agent || 'Advisor'} -> ${entry.model}`}
                    </Text>
                    {entry.verdict ? (
                      <Badge tone={entry.verdict === 'LGTM' ? 'success' : 'warning'}>
                        {entry.verdict}
                      </Badge>
                    ) : null}
                  </Row>
                  <RelativeTime at={entry.at} format="short" muted />
                </Row>
                <Markdown content={clipText(entry.advice)} />
                {snap && snap.terminals.length > 0 ? (
                  <Row gap="xs">
                    <Button
                      size="xs"
                      variant="outline"
                      icon="terminal"
                      disabled={busy === `inject:${entry.id}`}
                      onPress={() => injectAdvice(entry)}
                    >
                      {t.sendToTerminalBtn}
                    </Button>
                  </Row>
                ) : null}
                <Separator />
              </Stack>
            ))}
          </Stack>
        </Collapsible>
      ) : null}
    </Stack>
  )
}
