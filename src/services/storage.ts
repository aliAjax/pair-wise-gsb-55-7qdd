import type { AppState, OfflinePackage, SyncServerState } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { backfillRevisions } from './revision'

const STORAGE_KEY = 'grid-protection-review-v1'
const SERVER_KEY = 'grid-protection-server-v1'
const PACKAGE_KEY = 'grid-protection-offline-package-v1'

function parse<T>(raw: string | null, fallback: () => T): T {
  if (!raw) return fallback()
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback()
  }
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const initial = parse<AppState | null>(window.localStorage.getItem(STORAGE_KEY), () => null)
  if (!initial) {
    const seeded = createInitialState()
    saveState(seeded)
    return seeded
  }
  // 旧数据缺修订号时按首次导入回填（只补一次，留痕到 legacyMigration）
  if (
    initial.settings.some((item) => typeof item.rev !== 'number') ||
    initial.devices.some((item) => typeof item.rev !== 'number')
  ) {
    const migrated = backfillRevisions(initial, new Date().toISOString())
    if (migrated) {
      saveState(migrated)
      migrated.audit.unshift({
        id: `audit-migration-${Date.now()}`,
        action: '旧档案回填修订号',
        target: '首次导入迁移',
        operator: '系统',
        detail: `设备 ${migrated.legacyMigration?.backfilled.devices ?? 0} 条、定值 ${migrated.legacyMigration?.backfilled.settings ?? 0} 条、场景 ${migrated.legacyMigration?.backfilled.scenarios ?? 0} 条、基线 ${migrated.legacyMigration?.backfilled.baselines ?? 0} 条统一回填 rev=1，全局流水号推进至 ${migrated.headRev}。`,
        createdAt: migrated.legacyMigration?.at ?? new Date().toISOString(),
      })
      saveState(migrated)
    }
  }
  return initial
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  const migrated = backfillRevisions(initial, new Date().toISOString())
  const next = migrated ?? initial
  saveState(next)
  saveServerState({ state: next, receipts: {} })
  clearPackage()
  return next
}

// --- 调度端权威状态 ---------------------------------------------------------

export function loadServerState(): SyncServerState {
  if (typeof window === 'undefined') return { state: createInitialState(), receipts: {} }
  const existing = parse<SyncServerState | null>(window.localStorage.getItem(SERVER_KEY), () => null)
  if (existing) return existing
  // 首次进入：调度端以初始台账播种（与本地一致，均带 rev=1）
  const seeded = createInitialState()
  const migrated = backfillRevisions(seeded, new Date().toISOString())
  const state = migrated ?? seeded
  if (migrated?.legacyMigration) {
    const m = migrated.legacyMigration
    state.audit.unshift({
      id: `audit-migration-server-${Date.now()}`,
      action: '旧档案回填修订号',
      target: '调度端首次导入',
      operator: '系统',
      detail: `设备 ${m.backfilled.devices} 条、定值 ${m.backfilled.settings} 条、场景 ${m.backfilled.scenarios} 条、基线 ${m.backfilled.baselines} 条统一回填 rev=1，全局流水号推进至 ${m.headRev}。`,
      createdAt: m.at,
    })
  }
  const next = { state, receipts: {} }
  saveServerState(next)
  return next
}

export function saveServerState(server: SyncServerState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SERVER_KEY, JSON.stringify(server))
  }
}

export function resetServerState(): SyncServerState {
  const seeded = createInitialState()
  const migrated = backfillRevisions(seeded, new Date().toISOString())
  const state = migrated ?? seeded
  const next = { state, receipts: {} }
  saveServerState(next)
  return next
}

// --- 离线包 -----------------------------------------------------------------

export function loadPackage(): OfflinePackage | null {
  if (typeof window === 'undefined') return null
  return parse<OfflinePackage | null>(window.localStorage.getItem(PACKAGE_KEY), () => null)
}

export function savePackage(pkg: OfflinePackage | null): void {
  if (typeof window === 'undefined') return
  if (pkg) window.localStorage.setItem(PACKAGE_KEY, JSON.stringify(pkg))
  else window.localStorage.removeItem(PACKAGE_KEY)
}

export function clearPackage(): void {
  savePackage(null)
}

// --- CSV 导出 ---------------------------------------------------------------

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件,修订号',
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
        state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ?? target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
        setting.rev ?? 1,
      ].join(','),
    )
  })
  return lines.join('\n')
}
