import type { AppState, AuditEntry } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { backfillAuditEntries, normalizeState } from './revision'

const STORAGE_KEY = 'grid-protection-review-v2'
const LEGACY_STORAGE_KEY = 'grid-protection-review-v1'

export interface LoadResult {
  state: AppState
  /** 本次加载是否触发了旧数据修订号回填（用于进入时提示）。 */
  backfilled: boolean
  backfillNote: string
  migratedFromV1: boolean
}

function withBackfill(raw: Partial<AppState>, migratedFromV1: boolean): LoadResult {
  const result = normalizeState(raw)
  const entries = backfillAuditEntries(result)
  if (entries.length) {
    result.state.audit = [...entries, ...result.state.audit]
  }
  const settingCount = result.backfilledSettings.length
  const deviceCount = result.backfilledDevices.length
  const parts: string[] = []
  if (settingCount) parts.push(`${settingCount} 条定值`)
  if (deviceCount) parts.push(`${deviceCount} 台设备`)
  return {
    state: result.state,
    backfilled: entries.length > 0,
    backfillNote: parts.length
      ? `旧数据首次导入：${parts.join('、')}缺少修订号，已按首次导入回填为 rev 1。`
      : '',
    migratedFromV1,
  }
}

export function loadState(): LoadResult {
  if (typeof window === 'undefined') {
    return { state: createInitialState(), backfilled: false, backfillNote: '', migratedFromV1: false }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AppState>
      return withBackfill(parsed, false)
    } catch {
      const initial = createInitialState()
      saveState(initial)
      return { state: initial, backfilled: false, backfillNote: '', migratedFromV1: false }
    }
  }

  const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacyRaw) {
    try {
      const parsed = JSON.parse(legacyRaw) as Partial<AppState>
      const result = withBackfill(parsed, true)
      saveState(result.state)
      return result
    } catch {
      // fall through to fresh state
    }
  }

  const initial = createInitialState()
  saveState(initial)
  return { state: initial, backfilled: false, backfillNote: '', migratedFromV1: false }
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `有效版本：${effectiveVersionLabel(state)}`,
    '装置编号,保护装置,保护对象,段位,修订号,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件',
  ]
  state.settings.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        `rev ${setting.revision}`,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
      ].join(','),
    )
  })
  return lines.join('\n')
}

export function effectiveVersionLabel(state: AppState): string {
  const baseline = state.baselines.find((item) => item.id === state.activeBaselineId)
  return baseline ? `${baseline.version} (${baseline.checksum})` : '未发布有效版本'
}

/** 供外部“首次导入旧台账”演示使用：模拟一份缺修订号的导入批次。 */
export function buildLegacyImportBatch(existing: AppState): {
  devices: AppState['devices']
  settings: AppState['settings']
  audit: AuditEntry[]
} {
  const legacyDevice = {
    id: 'line-301',
    code: 'LINE-301',
    name: '西岭至北郊新线（旧台账导入）',
    kind: 'line' as const,
    station: '西岭变电站',
    voltage: 35,
    parentId: 'bus-35-b',
    status: 'running' as const,
    operationModes: ['正常方式'],
    revision: undefined as unknown as number,
  }
  const legacySetting = {
    id: 'set-l301-1',
    relayId: 'relay-l201',
    protectedDeviceId: 'line-301',
    stage: 'I' as const,
    currentA: 5.2,
    timeS: 0.1,
    direction: 'forward' as const,
    sensitivity: 1.62,
    recloseEnabled: true,
    recloseDelayS: 1.3,
    startCondition: '相电流突变量启动',
    updatedAt: new Date().toISOString(),
    revision: undefined as unknown as number,
  }
  return {
    devices: [...existing.devices, legacyDevice],
    settings: [...existing.settings, legacySetting],
    audit: [
      {
        id: `audit-legacy-import-${Date.now()}`,
        action: '导入旧版台账',
        target: legacyDevice.name,
        operator: '当前用户',
        detail: '导入数据缺少修订号字段，等待按首次导入规则回填。',
        createdAt: new Date().toISOString(),
        traceId: 'legacy-import',
      },
    ],
  }
}
