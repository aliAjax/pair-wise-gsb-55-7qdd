import type { AppState, ProtectionSetting } from '@/types/domain'

export const REV_FIELDS = [
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
] as const

export type RevField = (typeof REV_FIELDS)[number]

export const fieldLabels: Record<string, string> = {
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
  code: '设备编号',
  name: '设备名称',
  status: '运行状态',
  station: '所属站所',
  voltage: '电压等级',
  parentId: '上级设备',
}

/** 单条定值的校验码；基线锁定与执行页版本一致性都用它 */
export function settingFingerprint(setting: ProtectionSetting): string {
  const source = [
    setting.relayId,
    setting.stage,
    setting.currentA,
    setting.timeS,
    setting.direction,
    setting.sensitivity,
    setting.recloseEnabled,
    setting.recloseDelayS,
    setting.startCondition,
  ].join(':')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0')
}

/** 整份定值集合的校验码（基线沿用既有 8-4 展示风格） */
export function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return (
    value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
  )
}

export function snapshotMap(settings: ProtectionSetting[]): Map<string, ProtectionSetting> {
  return new Map(settings.map((item) => [item.id, item]))
}

/** 快照与当前定值逐条比对，返回发生漂移的定值 id */
export function driftedSettingIds(
  current: ProtectionSetting[],
  snapshot: ProtectionSetting[],
): string[] {
  const baseline = snapshotMap(snapshot)
  const ids: string[] = []
  current.forEach((item) => {
    const previous = baseline.get(item.id)
    if (!previous) {
      ids.push(item.id)
      return
    }
    if (REV_FIELDS.some((field) => previous[field] !== item[field])) ids.push(item.id)
  })
  snapshot.forEach((item) => {
    if (!current.some((currentItem) => currentItem.id === item.id)) ids.push(item.id)
  })
  return [...new Set(ids)]
}

/**
 * 旧数据缺修订号时按首次导入回填：
 * 实体 rev 缺失即视为旧档案，统一回填 1，并把全局流水号推进到实体数。
 * 返回迁移后的状态与回填数量（无缺失时返回 null）。
 */
export function backfillRevisions(state: AppState, at: string): AppState | null {
  let devices = 0
  let settings = 0
  let scenarios = 0
  let baselines = 0

  state.devices = state.devices.map((item) => {
    if (typeof item.rev === 'number') return item
    devices += 1
    return { ...item, rev: 1 }
  })
  state.settings = state.settings.map((item) => {
    if (typeof item.rev === 'number') return item
    settings += 1
    return { ...item, rev: 1 }
  })
  state.scenarios = state.scenarios.map((item) => {
    if (typeof item.rev === 'number') return item
    scenarios += 1
    return { ...item, rev: 1 }
  })
  state.baselines = state.baselines.map((item) => {
    if (typeof item.rev === 'number') return item
    baselines += 1
    return { ...item, rev: 1 }
  })

  const total = devices + settings + scenarios + baselines
  if (total === 0) return null

  const currentHead = state.headRev ?? 0
  state.headRev = Math.max(currentHead, total)
  state.legacyMigration = {
    at,
    backfilled: { devices, settings, scenarios, baselines },
    headRev: state.headRev,
    note: '旧档案缺少修订号，按首次导入统一回填为 rev=1',
  }
  return state
}

export function bumpHeadRev(state: AppState): number {
  state.headRev = (state.headRev ?? 0) + 1
  return state.headRev
}
