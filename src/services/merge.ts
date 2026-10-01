import type {
  AppState,
  FieldConflict,
  MergeFieldValue,
  MergeReport,
  OfflineChange,
  OfflinePackage,
  SyncEntityType,
} from '@/types/domain'
import { bumpHeadRev } from './revision'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const sameValue = (a: MergeFieldValue, b: MergeFieldValue) => a === b

export function entityOf(state: AppState, type: SyncEntityType, id: string) {
  if (type === 'setting') return state.settings.find((item) => item.id === id)
  return state.devices.find((item) => item.id === id)
}

export function conflictKey(change: OfflineChange) {
  return `${change.entityType}:${change.entityId}:${change.field}`
}

export function packageBaseKey(change: OfflineChange) {
  return `${change.entityType}:${change.entityId}:${change.field}`
}

export function packageRevKey(type: SyncEntityType, id: string) {
  return `rev:${type}:${id}`
}

function makeConflict(change: OfflineChange, serverValue: MergeFieldValue): FieldConflict {
  return {
    id: `conflict-${change.id}`,
    changeId: change.id,
    entityType: change.entityType,
    entityId: change.entityId,
    field: change.field,
    label: change.label,
    baseValue: change.baseValue,
    localValue: change.newValue,
    serverValue,
    status: 'pending',
  }
}

export interface BatchProgress {
  applied: number
  skipped: number
  conflicts: FieldConflict[]
  /** 触发批次中断时（模拟写入失败），返回处理到的游标；正常为 undefined */
  failureAt?: number
}

/**
 * 按批次逐条把离线变更写入服务器状态（可变 state，调用方负责持久化）。
 * 每个字段做三方合并：
 *   - 服务器仍等于离线基线值  → 现场改动可直接应用；
 *   - 服务器值 == 现场值       → 两端一致，跳过；
 *   - 服务器值与两者都不同     → 两端改过同一字段，保留两版待复核。
 * 已处理到 processed 游标（断点续传）。failBefore 用于模拟“写入失败”。
 */
export function applyBatch(
  state: AppState,
  pkg: OfflinePackage,
  options: { failBefore?: number } = {},
): BatchProgress {
  const progress: BatchProgress = { applied: 0, skipped: 0, conflicts: clone(pkg.conflicts) }
  const knownConflicts = new Map(progress.conflicts.map((item) => [conflictKey({
    id: item.changeId,
    entityType: item.entityType,
    entityId: item.entityId,
    field: item.field,
  } as OfflineChange), item]))

  for (let index = pkg.processed; index < pkg.changes.length; index += 1) {
    if (options.failBefore === index) {
      progress.failureAt = index
      return progress
    }
    const change = pkg.changes[index]
    const entity = entityOf(state, change.entityType, change.entityId)

    // 实体已被删除等极端情况：跳过并留待人工，不计冲突
    if (!entity) {
      progress.skipped += 1
      pkg.processed = index + 1
      continue
    }

    const serverValue = (entity as unknown as Record<string, unknown>)[change.field] as MergeFieldValue
    const key = conflictKey(change)

    if (sameValue(serverValue, change.newValue)) {
      // 调度端已改成同值：幂等跳过
      progress.skipped += 1
    } else if (sameValue(serverValue, change.baseValue)) {
      ;(entity as unknown as Record<string, MergeFieldValue>)[change.field] = change.newValue
      const revKey = packageRevKey(change.entityType, change.entityId)
      const baseRev = pkg.baseRevs[revKey] ?? (entity.rev ?? 1)
      entity.rev = baseRev + 1
      if ('updatedAt' in entity) entity.updatedAt = new Date().toISOString()
      bumpHeadRev(state)
      progress.applied += 1
    } else {
      // 两端都改了同一字段，且改法不同：保留两版，字段维持调度端值等待复核
      if (!knownConflicts.has(key)) {
        const conflict = makeConflict(change, serverValue)
        progress.conflicts.push(conflict)
        knownConflicts.set(key, conflict)
      }
      progress.conflicts = progress.conflicts.map((item) =>
        item.changeId === change.id ? { ...item, serverValue } : item,
      )
    }
    pkg.processed = index + 1
  }
  return progress
}

export function summarizeReport(
  pkg: OfflinePackage,
  progress: BatchProgress,
  cascade: MergeReport['cascade'],
): MergeReport {
  return {
    packageId: pkg.id,
    total: pkg.changes.length,
    applied: progress.applied,
    skipped: progress.skipped,
    conflicts: progress.conflicts.length,
    finishedAt: new Date().toISOString(),
    cascade,
  }
}
