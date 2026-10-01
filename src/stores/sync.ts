import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  FieldConflict,
  MergeFieldValue,
  OfflineChange,
  OfflinePackage,
  ProtectionSetting,
  ServerPackageReceipt,
  SyncEntityType,
} from '@/types/domain'
import {
  loadPackage,
  pullServer,
  reflectLocalState,
  resolveConflict,
  savePackage,
  simulateDispatchChange,
  submitOfflinePackage,
} from '@/api/client'
import { REV_FIELDS, fieldLabels } from '@/services/revision'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const baseKey = (type: SyncEntityType, id: string, field: string) => `${type}:${id}:${field}`
const revKey = (type: SyncEntityType, id: string) => `rev:${type}:${id}`

/**
 * 断网/回网协同状态机：
 * online →（断网冻结基线）→ offline →（编辑累计离线包）→ online
 * 回网提交后按字段三方合并，冲突留两版进入待复核。
 */
export const useSyncStore = defineStore('grid-sync', () => {
  const online = ref(true)
  const serverState = ref<AppState | null>(null)
  const receipts = ref<Record<string, ServerPackageReceipt>>({})
  const pkg = ref<OfflinePackage | null>(loadPackage())
  const busy = ref(false)
  const lastSyncMessage = ref('')

  const serverHeadRev = computed(() => serverState.value?.headRev ?? 0)
  const pendingConflicts = computed<FieldConflict[]>(
    () => pkg.value?.conflicts.filter((item) => item.status === 'pending') ?? [],
  )
  const resolvedConflicts = computed<FieldConflict[]>(
    () => pkg.value?.conflicts.filter((item) => item.status === 'resolved') ?? [],
  )
  const offlineChanges = computed(() => pkg.value?.changes ?? [])
  const hasUnfinishedPackage = computed(
    () => !!pkg.value && ['partial', 'conflict'].includes(pkg.value.status),
  )

  function hydrateServer(payload: {
    state: AppState
    receipts: Record<string, ServerPackageReceipt>
  }) {
    serverState.value = payload.state
    receipts.value = payload.receipts
  }

  async function pull() {
    busy.value = true
    try {
      const result = await pullServer()
      hydrateServer(result)
      // 刷新/重开页面后，用服务端回执校正本地离线包的游标与冲突列表
      if (pkg.value) {
        const receipt = result.receipts[pkg.value.id] as
          | (ServerPackageReceipt & { serverPackage?: OfflinePackage })
          | undefined
        if (receipt?.serverPackage) {
          const serverPkg = receipt.serverPackage
          pkg.value = {
            ...serverPkg,
            // 本地可能已记录但尚未提交的新增变更要保留（仅 draft 阶段）
            changes:
              serverPkg.status === 'draft'
                ? serverPkg.changes.length
                  ? serverPkg.changes
                  : pkg.value.changes
                : serverPkg.changes,
          }
          savePackage(pkg.value)
        }
      }
      return result.state
    } finally {
      busy.value = false
    }
  }

  function goOffline(state: AppState, author = '现场工程师') {
    if (!online.value) return
    online.value = false
    const baseSnapshot: Record<string, MergeFieldValue> = {}
    const baseRevs: Record<string, number> = {}
    state.settings.forEach((item) => {
      REV_FIELDS.forEach((field) => {
        baseSnapshot[baseKey('setting', item.id, field)] = item[field] as MergeFieldValue
      })
      baseRevs[revKey('setting', item.id)] = item.rev ?? 1
    })
    state.devices.forEach((item) => {
      baseRevs[revKey('device', item.id)] = item.rev ?? 1
    })
    // 已有失败待恢复的包时沿用；否则新建现场离线包
    if (!pkg.value || ['merged', 'rejected'].includes(pkg.value.status)) {
      const next: OfflinePackage = {
        id: createId('pkg'),
        author,
        baseHeadRev: state.headRev ?? 0,
        createdAt: new Date().toISOString(),
        status: 'draft',
        baseSnapshot,
        baseRevs,
        changes: [],
        conflicts: [],
        processed: 0,
      }
      pkg.value = next
      savePackage(next)
    } else {
      // 保留既有包的修订基线（失败重试场景）
      pkg.value.status = 'draft'
      savePackage(pkg.value)
    }
    lastSyncMessage.value = '已断开调度链路，后续定值修改写入现场离线包。'
  }

  function goOnline() {
    online.value = true
    lastSyncMessage.value = '链路已恢复，可回网合并现场离线包。'
  }

  function settingLabel(state: AppState, setting: ProtectionSetting) {
    const relay = state.devices.find((item) => item.id === setting.relayId)?.name ?? setting.relayId
    return `${relay} ${setting.stage} 段`
  }

  /**
   * 断网期间记录字段级变更：
   * 同一字段只保留最新一笔，但基线值恒为断网瞬间冻结值。
   */
  function recordSettingChange(
    state: AppState,
    setting: ProtectionSetting,
    field: (typeof REV_FIELDS)[number],
    newValue: MergeFieldValue,
  ) {
    if (!pkg.value) throw new Error('当前不存在离线包')
    const frozen = pkg.value.baseSnapshot[baseKey('setting', setting.id, field)]
    if (frozen === undefined) {
      throw new Error(`离线包缺少 ${setting.id}.${field} 的断网基线值，不能纳入合并`)
    }
    const baseValue = frozen
    const existingIndex = pkg.value.changes.findIndex(
      (item) => item.entityType === 'setting' && item.entityId === setting.id && item.field === field,
    )
    const label = settingLabel(state, setting)
    if (existingIndex >= 0) {
      pkg.value.changes[existingIndex] = {
        ...pkg.value.changes[existingIndex],
        newValue,
        baseValue,
      }
    } else {
      const change: OfflineChange = {
        id: createId('chg'),
        entityType: 'setting',
        entityId: setting.id,
        field,
        label,
        baseValue,
        newValue,
        baseRev: pkg.value.baseRevs[revKey('setting', setting.id)] ?? setting.rev ?? 1,
        createdAt: new Date().toISOString(),
      }
      pkg.value.changes.push(change)
    }
    savePackage(pkg.value)
  }

  /** 回网合并：提交离线包。failBefore 用于演示写入失败后的可恢复批次。 */
  async function submitPackage(failBefore?: number) {
    if (!pkg.value) throw new Error('没有可提交的离线包')
    busy.value = true
    try {
      pkg.value.status = 'submitting'
      const result = await submitOfflinePackage(clone(pkg.value), failBefore)
      serverState.value = result.state
      receipts.value = { ...receipts.value, [result.receipt.packageId]: result.receipt }
      pkg.value = result.pkg
      savePackage(pkg.value)
      lastSyncMessage.value =
        result.message ??
        (result.failed
          ? '部分批次写入失败，可从断点继续恢复。'
          : `离线包合并完成：应用 ${result.receipt.report?.applied ?? 0} 项，冲突 ${result.receipt.report?.conflicts ?? 0} 项。`)
      return result
    } finally {
      busy.value = false
    }
  }

  /** 幂等重试：服务端按回执游标只续传未完成批次 */
  async function resumePackage() {
    if (!pkg.value) throw new Error('没有可恢复的离线包')
    return submitPackage(undefined)
  }

  async function resolveOne(conflictId: string, resolution: 'local' | 'server') {
    busy.value = true
    try {
      const result = await resolveConflict(conflictId, resolution)
      serverState.value = result.state
      receipts.value = { ...receipts.value, [result.receipt.packageId]: result.receipt }
      pkg.value = result.pkg
      savePackage(pkg.value)
      lastSyncMessage.value = '冲突裁定已落库，校核问题、场景与基线已重算。'
      return result
    } finally {
      busy.value = false
    }
  }

  async function simulateDispatchEdit(input: {
    settingId: string
    field: string
    value: MergeFieldValue
  }) {
    busy.value = true
    try {
      const result = await simulateDispatchChange({ ...input, operator: '调度值班员' })
      serverState.value = result.state
      lastSyncMessage.value = '调度端改动已落到权威版本（修订号 +1）。'
      return result
    } finally {
      busy.value = false
    }
  }

  /** 在线编辑后把本地状态镜像为权威版本 */
  async function reflect(state: AppState) {
    const result = await reflectLocalState(state)
    if ('stale' in result) return result
    serverState.value = result.state
    return result
  }

  /** 合并/拉取后，把服务端权威状态交给调用方（app store）做本地对齐 */
  async function pullAndGet(): Promise<AppState> {
    return pull()
  }

  function closePackage() {
    if (pkg.value) {
      savePackage(null)
      pkg.value = null
    }
  }

  function discardPackage() {
    closePackage()
    lastSyncMessage.value = '现场离线包已丢弃。'
  }

  return {
    online,
    busy,
    serverState,
    receipts,
    pkg,
    lastSyncMessage,
    serverHeadRev,
    pendingConflicts,
    resolvedConflicts,
    offlineChanges,
    hasUnfinishedPackage,
    pull,
    pullAndGet,
    hydrateServer,
    goOffline,
    goOnline,
    recordSettingChange,
    submitPackage,
    resumePackage,
    resolveOne,
    simulateDispatchEdit,
    reflect,
    closePackage,
    discardPackage,
  }
})

export { fieldLabels }
