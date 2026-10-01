import type {
  AppState,
  AuditEntry,
  FieldValue,
  MergeConflict,
  OfflineItem,
  ProtectionSetting,
  SettingField,
} from '@/types/domain'
import {
  issuesPreservingState,
  settingsChecksum,
} from './revision'
import { validateSettings } from './validation'

export const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

export const nowIso = () => new Date().toISOString()

export interface MergeItemResult {
  item: OfflineItem
  setting?: ProtectionSetting
  conflict?: MergeConflict
  applied: boolean
}

/**
 * 单条离线修改的三方合并：
 * base 为离线封存时的共同版本，offline 为现场版，server 为回网时调度端在库版。
 * - 调度端未动该字段：现场版直接快进合并；
 * - 调度端已改成现场相同值：自动一致，跳过；
 * - 两端改过同一字段且取值不同：保留两版，生成待复核冲突，不覆盖任何一方。
 */
export function mergeOneItem(
  settings: ProtectionSetting[],
  pkg: AppState['offlinePackages'][number],
  item: OfflineItem,
): MergeItemResult {
  const setting = settings.find((candidate) => candidate.id === item.settingId)
  if (!setting) {
    return {
      applied: false,
      item: {
        ...item,
        status: 'skipped',
        message: '台账中已找不到该定值（可能已被调度端删除），未写入。',
      },
    }
  }

  const base: FieldValue = item.baseValue
  const offline: FieldValue = item.offlineValue
  const server: FieldValue = setting[item.field as SettingField]

  if (server === offline) {
    return {
      applied: false,
      setting,
      item: {
        ...item,
        status: 'skipped',
        message: '调度端在库值与现场修改一致，自动合并，无需重复写入。',
      },
    }
  }

  if (server === base) {
    const next: ProtectionSetting = {
      ...setting,
      [item.field]: offline,
      revision: setting.revision + 1,
      updatedAt: nowIso(),
    }
    return {
      applied: true,
      setting: next,
      item: { ...item, status: 'applied', message: '调度端未改动该字段，现场版已快进合并。' },
    }
  }

  const conflict: MergeConflict = {
    id: newId('conflict'),
    packageId: pkg.id,
    packageCode: pkg.code,
    itemId: item.id,
    settingId: item.settingId,
    field: item.field,
    baseValue: base,
    offlineValue: offline,
    dispatchValue: server,
    status: 'pending',
    createdAt: nowIso(),
  }
  return {
    applied: false,
    setting,
    conflict,
    item: {
      ...item,
      status: 'conflict',
      message: '现场与调度端均修改了该字段，两版均已保留待复核。',
    },
  }
}

function replaceSetting(settings: ProtectionSetting[], next: ProtectionSetting) {
  const index = settings.findIndex((item) => item.id === next.id)
  if (index >= 0) settings[index] = next
}

export interface ProcessPackageOptions {
  /** 1 基序号：处理到第几个待写入项时模拟写入失败；之前已完成项落盘，之后可断点续传。 */
  failAtItem?: number
  clientId: string
}

export interface ProcessPackageResult {
  state: AppState
  appliedCount: number
  conflictCount: number
  skippedCount: number
  interrupted: boolean
}

/**
 * 批次化处理离线包：逐项合并、逐项落盘审计。
 * 注入写入失败时保留已完成批次、包回到 submitting，提交锁标记 interrupted，可继续恢复。
 */
export function processPackage(
  input: AppState,
  packageId: string,
  options: ProcessPackageOptions,
): ProcessPackageResult {
  const state: AppState = JSON.parse(JSON.stringify(input)) as AppState
  const pkg = state.offlinePackages.find((item) => item.id === packageId)
  const empty: ProcessPackageResult = {
    state,
    appliedCount: 0,
    conflictCount: 0,
    skippedCount: 0,
    interrupted: false,
  }
  if (!pkg) return empty

  if (pkg.status === 'draft') return empty

  let appliedCount = 0
  let conflictCount = 0
  let skippedCount = 0
  let interrupted = false
  const pendingOrder = pkg.items
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.status === 'pending')

  pkg.status = 'submitting'
  pkg.submittedAt = pkg.submittedAt ?? nowIso()
  pkg.lastError = undefined

  const pushAudit = (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: newId('audit'), createdAt: nowIso() })
  }

  for (let order = 0; order < pendingOrder.length; order += 1) {
    const { index } = pendingOrder[order]
    const item = pkg.items[index]

    if (options.failAtItem === order + 1) {
      interrupted = true
      pkg.lastError = `第 ${order + 1} 批写入失败（网络中断/存储失败），已完成 ${order} 项，可恢复续传。`
      pushAudit({
        action: '离线合并中断',
        target: pkg.code,
        operator: pkg.operator,
        detail: pkg.lastError,
        traceId: pkg.code,
      })
      break
    }

    const result = mergeOneItem(state.settings, pkg, item)
    pkg.items[index] = result.item
    if (result.applied && result.setting) {
      replaceSetting(state.settings, result.setting)
      appliedCount += 1
      pushAudit({
        action: '离线合并写入',
        target: `${pkg.code} / ${item.settingId}.${item.field}`,
        operator: pkg.operator,
        detail: `字段 ${item.field} 写入现场版 ${String(item.offlineValue)}，定值修订号自增为 rev ${result.setting.revision}。`,
        traceId: pkg.code,
      })
    } else if (result.conflict) {
      state.mergeConflicts.unshift(result.conflict)
      conflictCount += 1
      pushAudit({
        action: '合并冲突待复核',
        target: `${pkg.code} / ${item.settingId}.${item.field}`,
        operator: pkg.operator,
        detail: `基线值 ${String(result.conflict.baseValue)}，现场版 ${String(result.conflict.offlineValue)}，调度版 ${String(result.conflict.dispatchValue)}，两版均保留。`,
        traceId: pkg.code,
      })
    } else {
      skippedCount += 1
      pushAudit({
        action: '离线合并跳过',
        target: `${pkg.code} / ${item.settingId}.${item.field}`,
        operator: pkg.operator,
        detail: result.item.message ?? '该项无需写入。',
        traceId: pkg.code,
      })
    }

    // 逐项落盘：保存中间状态并登记进行锁，保证写入失败后已完成批次不丢失。
    state.submissionLocks[pkg.idempotencyKey] = {
      status: 'interrupted',
      clientId: options.clientId,
      updatedAt: nowIso(),
      attempts: (state.submissionLocks[pkg.idempotencyKey]?.attempts ?? 0) + 1,
    }
  }

  const hasPending = pkg.items.some((item) => item.status === 'pending')
  if (!hasPending && !interrupted) {
    pkg.status = 'merged'
    pkg.mergedAt = nowIso()
    pkg.lastError = undefined
    state.submissionLocks[pkg.idempotencyKey] = {
      status: 'committed',
      clientId: options.clientId,
      updatedAt: nowIso(),
      attempts: (state.submissionLocks[pkg.idempotencyKey]?.attempts ?? 0) + 1,
    }
    const previousIssues = state.issues
    state.issues = issuesPreservingState(
      validateSettings(state.settings, state.devices),
      previousIssues,
    )
    pushAudit({
      action: '离线包合并完成',
      target: pkg.code,
      operator: pkg.operator,
      detail: `写入 ${appliedCount} 项，冲突保留 ${conflictCount} 项，自动一致跳过 ${skippedCount} 项；定值校验码变为 ${settingsChecksum(state.settings)}，校核问题、场景与会签基线已按新定值失效重算。`,
      traceId: pkg.code,
    })
  }

  return { state, appliedCount, conflictCount, skippedCount, interrupted }
}

export interface ResolveConflictResult {
  state: AppState
  setting?: ProtectionSetting
}

/** 冲突复核裁决：定值随裁决结果修订，校核问题随之重算。 */
export function resolveConflict(
  input: AppState,
  conflictId: string,
  choice: 'offline' | 'dispatch',
  operator: string,
): ResolveConflictResult {
  const state: AppState = JSON.parse(JSON.stringify(input)) as AppState
  const conflict = state.mergeConflicts.find((item) => item.id === conflictId)
  if (!conflict || conflict.status !== 'pending') return { state }

  const setting = state.settings.find((item) => item.id === conflict.settingId)
  let nextSetting: ProtectionSetting | undefined
  const chosenValue = choice === 'offline' ? conflict.offlineValue : conflict.dispatchValue

  if (setting) {
    nextSetting = {
      ...setting,
      [conflict.field]: chosenValue,
      revision: setting.revision + 1,
      updatedAt: nowIso(),
    }
    replaceSetting(state.settings, nextSetting)
  }

  conflict.status = choice === 'offline' ? 'resolved-offline' : 'resolved-dispatch'
  conflict.resolvedBy = operator
  conflict.resolvedAt = nowIso()

  const pkg = state.offlinePackages.find((item) => item.id === conflict.packageId)
  if (pkg) {
    const itemIndex = pkg.items.findIndex((item) => item.id === conflict.itemId)
    if (itemIndex >= 0) {
      pkg.items[itemIndex] = {
        ...pkg.items[itemIndex],
        status: choice === 'offline' ? 'applied' : 'skipped',
        message:
          choice === 'offline'
            ? '复核采用现场离线版，已写入。'
            : '复核采用调度端版本，现场版未写入。',
      }
    }
  }

  const previousIssues = state.issues
  state.issues = issuesPreservingState(
    validateSettings(state.settings, state.devices),
    previousIssues,
  )

  state.audit.unshift({
    id: newId('audit'),
    action: '冲突复核裁决',
    target: `${conflict.packageCode} / ${conflict.settingId}.${conflict.field}`,
    operator,
    detail:
      choice === 'offline'
        ? `采用现场离线版 ${String(conflict.offlineValue)}，定值修订号自增为 rev ${nextSetting?.revision ?? '?'}，校核问题已重算。`
        : `采用调度端版本 ${String(conflict.dispatchValue)}，现场版 ${String(conflict.offlineValue)} 作废；校核问题已重算。`,
    createdAt: nowIso(),
    traceId: conflict.packageCode,
  })

  return { state, setting: nextSetting }
}

/** 合并/裁决后统一的失效判定辅助，供页面展示。 */
export function staleSummary(state: AppState, checksum: string) {
  const scenarios = state.scenarios.filter(
    (scenario) => scenario.basisChecksum && scenario.basisChecksum !== checksum,
  )
  const baselines = state.baselines.filter(
    (baseline) =>
      baseline.status !== 'locked' &&
      baseline.id !== state.activeBaselineId &&
      baseline.checksum !== checksum,
  )
  return { scenarios, baselines }
}
