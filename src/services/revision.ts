import type {
  AppState,
  AuditEntry,
  Device,
  FaultScenario,
  ProtectionSetting,
  SettingField,
  ValidationIssue,
} from '@/types/domain'
import { validateSettings } from './validation'

export const SCHEMA_VERSION = 2

export const SETTING_FIELDS: SettingField[] = [
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
]

export const settingFieldLabels: Record<SettingField, string> = {
  currentA: '电流定值(A)',
  timeS: '动作时限(s)',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟(s)',
  startCondition: '启动条件',
}

/** 当前定值集的稳定校验码，用于基线、场景与离线包的共同比对基准。 */
export function settingsChecksum(settings: ProtectionSetting[]): string {
  const source = [...settings]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) =>
      SETTING_FIELDS.map((field) => `${field}=${String(item[field])}`).join(','),
    )
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value
    .toString(16)
    .toUpperCase()
    .padStart(8, '0')
    .match(/.{4}/g)
    ?.join('-') ?? '0000-0000'
}

export function formatFieldValue(field: SettingField, value: unknown): string {
  if (field === 'recloseEnabled') return value ? '投入' : '退出'
  return String(value)
}

export interface NormalizeResult {
  state: AppState
  backfilledSettings: ProtectionSetting[]
  backfilledDevices: Device[]
}

/**
 * 旧数据缺修订号时按首次导入回填为 1：
 * 对历史 localStorage 数据与首次导入的外部台账统一补齐 revision 与新集合。
 */
export function normalizeState(raw: Partial<AppState>): NormalizeResult {
  const backfilledSettings: ProtectionSetting[] = []
  const backfilledDevices: Device[] = []

  const settings = (raw.settings ?? []).map((setting) => {
    const legacy = setting as ProtectionSetting & { revision?: number }
    if (typeof legacy.revision !== 'number') {
      backfilledSettings.push(legacy)
      return { ...legacy, revision: 1 }
    }
    return legacy
  })

  const devices = (raw.devices ?? []).map((device) => {
    const legacy = device as Device & { revision?: number }
    if (typeof legacy.revision !== 'number') {
      backfilledDevices.push(legacy)
      return { ...legacy, revision: 1 }
    }
    return legacy
  })

  const scenarios = (raw.scenarios ?? []).map((scenario) => {
    const legacy = scenario as FaultScenario & { basisChecksum?: string }
    if (!legacy.basisChecksum && (legacy.status === 'approved' || legacy.status === 'locked')) {
      return { ...legacy, basisChecksum: '__APPROVED_PRE_REVISION__' }
    }
    return legacy
  })

  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      networkMode: raw.networkMode ?? 'online',
      devices,
      settings,
      issues: raw.issues ?? [],
      scenarios,
      baselines: raw.baselines ?? [],
      comments: raw.comments ?? [],
      audit: raw.audit ?? [],
      activeBaselineId: raw.activeBaselineId,
      offlinePackages: raw.offlinePackages ?? [],
      mergeConflicts: raw.mergeConflicts ?? [],
      submissionLocks: raw.submissionLocks ?? {},
      executionRecords: raw.executionRecords ?? [],
    },
    backfilledSettings,
    backfilledDevices,
  }
}

/** 以“批准前修订号体系”标记的历史场景：当前校验码必然与其不一致，需重新验证。 */
export function isScenarioStale(scenario: FaultScenario, checksum: string): boolean {
  if (!scenario.basisChecksum) return false
  return scenario.basisChecksum !== checksum
}

export function isBaselineStale(baseline: AppState['baselines'][number], checksum: string): boolean {
  // 已锁定基线作为有效版本永不被在线修改推翻，只有会签中基线参与失效重算。
  return baseline.status !== 'locked' && baseline.checksum !== checksum
}

/**
 * 定值一变，校核问题全量重算；保留仍存在问题的处理状态与会签轨迹。
 * 返回重算后的问题列表，以及受影响的失效场景/基线（按校验码判定）。
 */
export function recalcIssues(settings: ProtectionSetting[], devices: Device[]): ValidationIssue[] {
  const previousIssues = validateSettings(settings, devices)
  return previousIssues
}

export function issuesPreservingState(
  nextIssues: ValidationIssue[],
  previous: ValidationIssue[],
): ValidationIssue[] {
  const previousMap = new Map(previous.map((issue) => [issue.id, issue]))
  return nextIssues.map((issue) => {
    const old = previousMap.get(issue.id)
    return old ? { ...issue, status: old.status } : issue
  })
}

export function affectedSettingIds(settings: ProtectionSetting[], ids: string[]): Set<string> {
  const changed = new Set(ids)
  const relayIds = new Set(
    settings.filter((setting) => changed.has(setting.id)).map((setting) => setting.relayId),
  )
  // 同装置各段相互配合，一段变更全装置条目都纳入影响范围。
  settings.forEach((setting) => {
    if (relayIds.has(setting.relayId)) changed.add(setting.id)
  })
  return changed
}

export function backfillAuditEntries(
  result: NormalizeResult,
  operator = '系统',
): AuditEntry[] {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const entries: AuditEntry[] = []
  if (result.backfilledSettings.length) {
    entries.push({
      id: `audit-backfill-setting-${stamp}`,
      action: '历史数据回填',
      target: '保护定值修订号',
      operator,
      detail: `首次导入检测到 ${result.backfilledSettings.length} 条定值缺少修订号，已按首次导入回填为 rev 1。`,
      createdAt: new Date().toISOString(),
      traceId: 'legacy-import',
    })
  }
  if (result.backfilledDevices.length) {
    entries.push({
      id: `audit-backfill-device-${stamp}`,
      action: '历史数据回填',
      target: '设备台账修订号',
      operator,
      detail: `首次导入检测到 ${result.backfilledDevices.length} 台设备缺少修订号，已按首次导入回填为 rev 1。`,
      createdAt: new Date().toISOString(),
      traceId: 'legacy-import',
    })
  }
  return entries
}
