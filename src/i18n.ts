export type UiStrings = {
  enabledLabel: string
  statusActive: string
  statusPaused: string
  statusConsulting: (caller: string, target: string) => string
  providerLabel: string
  modelLabel: string
  effortLabel: string
  effortDefault: string
  effortLow: string
  effortMedium: string
  effortHigh: string
  effortXHigh: string
  effortMax: string
  modelSearchLabel: string
  modelSearchPlaceholder: string
  loadingModels: string
  refreshModelsTooltip: string
  customModelOption: string
  customModelPlaceholder: string
  applyBtn: string
  cancelBtn: string
  apiKeyLabel: string
  apiKeyPlaceholder: string
  saveKeyBtn: string
  levelLabel: string
  levelRare: string
  levelRareDesc: string
  levelBalanced: string
  levelBalancedDesc: string
  levelFrequent: string
  levelFrequentDesc: string
  thinkingLabel: string
  loopTitle: (count: number, tool: string) => string
  unstickBtn: string
  pendingDiffTitle: (added: number, removed: number) => string
  reviewNowBtn: string
  dismissBtn: string
  retryBtn: string
  reapproveHint: string
  recentHeading: (count: number) => string
  sendToTerminalBtn: string
}

const EN: UiStrings = {
  enabledLabel: 'On',
  statusActive: 'Active',
  statusPaused: 'Off',
  statusConsulting: (caller, target) => `${caller} -> ${target}`,
  providerLabel: 'Provider',
  modelLabel: 'Model',
  effortLabel: 'Thinking / Effort',
  effortDefault: 'Default',
  effortLow: 'Low',
  effortMedium: 'Medium',
  effortHigh: 'High',
  effortXHigh: 'Extra High (xhigh)',
  effortMax: 'Max',
  modelSearchLabel: 'Filter models',
  modelSearchPlaceholder: 'Search model (opus, gpt-6, o3, sonnet...)',
  loadingModels: 'Loading models...',
  refreshModelsTooltip: 'Refresh models',
  customModelOption: 'Custom model ID...',
  customModelPlaceholder: 'Enter model ID',
  applyBtn: 'Apply',
  cancelBtn: 'Cancel',
  apiKeyLabel: 'API key',
  apiKeyPlaceholder: 'Paste API key (stored in OS keyring)',
  saveKeyBtn: 'Save',
  levelLabel: 'Advisor level',
  levelRare: 'Rare',
  levelRareDesc: 'Only when stuck or on major architectural forks',
  levelBalanced: 'Balanced',
  levelBalancedDesc: 'Plan sanity-checks, loop breaking, and diff review suggestions',
  levelFrequent: 'Frequent',
  levelFrequentDesc: 'Frequent consultations and automatic diff reviews',
  thinkingLabel: 'Consulting advisor...',
  loopTitle: (count, tool) => `Loop detected (${count}x ${tool})`,
  unstickBtn: 'Unstick',
  pendingDiffTitle: (added, removed) => `Unreviewed diff (+${added} / -${removed})`,
  reviewNowBtn: 'Review diff',
  dismissBtn: 'Dismiss',
  retryBtn: 'Retry',
  reapproveHint: 'Plugin files updated — approve reload in Orca to reconnect.',
  recentHeading: (count) => `Recent advice (${count})`,
  sendToTerminalBtn: 'Send to terminal'
}

const RU: UiStrings = {
  enabledLabel: 'Вкл',
  statusActive: 'Активен',
  statusPaused: 'Выключен',
  statusConsulting: (caller, target) => `${caller} -> ${target}`,
  providerLabel: 'Провайдер',
  modelLabel: 'Модель',
  effortLabel: 'Рассуждения (Effort)',
  effortDefault: 'По умолчанию',
  effortLow: 'Низкий (low)',
  effortMedium: 'Средний (medium)',
  effortHigh: 'Высокий (high)',
  effortXHigh: 'Очень высокий (xhigh)',
  effortMax: 'Максимум (max)',
  modelSearchLabel: 'Поиск модели',
  modelSearchPlaceholder: 'Фильтр (opus, gpt-6, o3, sonnet...)',
  loadingModels: 'Загрузка моделей...',
  refreshModelsTooltip: 'Обновить список моделей',
  customModelOption: 'Свой ID модели...',
  customModelPlaceholder: 'Введите ID модели',
  applyBtn: 'Применить',
  cancelBtn: 'Отмена',
  apiKeyLabel: 'API-ключ',
  apiKeyPlaceholder: 'Вставьте API-ключ (шифруется в системе)',
  saveKeyBtn: 'Сохранить',
  levelLabel: 'Уровень советчика',
  levelRare: 'Редко',
  levelRareDesc: 'Только в тупике или при серьёзных развилках',
  levelBalanced: 'Средне',
  levelBalancedDesc: 'Сверка плана, выход из циклов и ревью крупных правок',
  levelFrequent: 'Часто',
  levelFrequentDesc: 'Частые консультации и автопроверка diff после правок',
  thinkingLabel: 'Запрос к советнику...',
  loopTitle: (count, tool) => `Зацикливание (${count}× ${tool})`,
  unstickBtn: 'Разобрать',
  pendingDiffTitle: (added, removed) => `Непроверенный diff (+${added} / -${removed})`,
  reviewNowBtn: 'Проверить',
  dismissBtn: 'Скрыть',
  retryBtn: 'Повторить',
  reapproveHint: 'Плагин обновился — подтвердите перезагрузку в Orca.',
  recentHeading: (count) => `Последние советы (${count})`,
  sendToTerminalBtn: 'В терминал'
}

export function getStrings(locale: string): UiStrings {
  return locale.toLowerCase().startsWith('ru') ? RU : EN
}
