import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import type {
  AppState,
  FieldConflict,
  MergeFieldValue,
  OfflinePackage,
  ServerPackageReceipt,
  SyncServerState,
} from '@/types/domain'
import {
  clearPackage,
  exportSettingsText,
  loadPackage,
  loadServerState,
  loadState,
  resetState,
  savePackage,
  saveServerState,
  saveState,
} from '@/services/storage'
import { recomputeAfterSettingChange } from '@/services/cascade'
import { applyBatch, entityOf, summarizeReport } from '@/services/merge'

type MockRequest = {
  state?: AppState
  patch?: Partial<AppState>
  action?: 'reset' | 'export'
  pkg?: OfflinePackage
  failBefore?: number
  settingId?: string
  field?: string
  value?: MergeFieldValue
  operator?: string
  conflictId?: string
  resolution?: 'local' | 'server'
}

function ok<T>(config: AxiosRequestConfig, data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : 'CONFLICT',
    headers: {},
    config: config as AxiosResponse<T>['config'],
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const serverNow = () => new Date().toISOString()
const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

/** 模拟同一份包并发提交：服务端处理窗口内第二个提交直接拒绝 */
const inFlight = new Set<string>()
const processingDelay = () => new Promise((resolve) => window.setTimeout(resolve, 420))

interface StoredReceipt extends ServerPackageReceipt {
  /** 服务端保存的包副本：断点续传与冲突列表的权威来源 */
  serverPackage: OfflinePackage
  appliedTotal: number
  skippedTotal: number
}

function audit(
  server: SyncServerState,
  entry: { action: string; target: string; operator: string; detail: string },
) {
  server.state.audit.unshift({ id: createId('audit'), createdAt: serverNow(), ...entry })
}

/**
 * 处理离线包提交。
 * - 已完整接收的包再次提交（含两人同时各交一份相同包）→ 409，仅首次放行；
 * - 处理中重复到达 → 409 in-flight；
 * - 之前写入中断 → 从回执游标恢复，只续传未完成批次。
 */
async function handleMerge(
  server: SyncServerState,
  payload: MockRequest,
): Promise<AxiosResponse> {
  const incoming = payload.pkg
  if (!incoming) throw new Error('缺少离线包内容')

  // 同一份包两人同时提交：只放行一份
  if (inFlight.has(incoming.id)) {
    return ok(
      {} as AxiosRequestConfig,
      {
        duplicate: true,
        reason: 'in-flight',
        message: '同一份离线包正在提交，重复提交已被拒绝，仅放行首次提交。',
      },
      409,
    )
  }

  const existing = server.receipts[incoming.id] as StoredReceipt | undefined
  if (existing && existing.status === 'merged') {
    return ok(
      {} as AxiosRequestConfig,
      {
        duplicate: true,
        reason: 'already-accepted',
        receipt: stripReceipt(existing),
        message: `离线包 ${incoming.id} 已被接收（首次提交于 ${new Date(existing.acceptedAt).toLocaleString('zh-CN')}），重复提交不再放行。`,
      },
      409,
    )
  }

  inFlight.add(incoming.id)
  try {
    // 模拟服务端处理窗口：窗口内到达的第二份相同包被 in-flight 拒绝
    await processingDelay()
    // 服务端副本为准（回执游标、冲突列表都在副本上）；首次提交用入站包
    const pkg: OfflinePackage = existing
      ? clone(existing.serverPackage)
      : clone(incoming)
    if (existing) {
      // 恢复：以服务端已完成批次游标为准，忽略客户端可能滞后的计数
      pkg.processed = existing.processed
      pkg.status = 'submitting'
    }

    const startProcessed = pkg.processed
    const progress = applyBatch(server.state, pkg, { failBefore: payload.failBefore })
    const failed = typeof progress.failureAt === 'number'

    // 记录受影响的定值，供级联重算（合并应用到的 + 产生冲突涉及的）
    const changedSettingIds = new Set<string>()
    pkg.changes
      .slice(startProcessed, failed ? progress.failureAt : pkg.changes.length)
      .forEach((change) => {
        if (change.entityType === 'setting') changedSettingIds.add(change.entityId)
      })
    progress.conflicts.forEach((conflict) => {
      if (conflict.entityType === 'setting') changedSettingIds.add(conflict.entityId)
    })

    let cascade
    if (changedSettingIds.size > 0) {
      cascade = recomputeAfterSettingChange(server.state, [...changedSettingIds])
    }

    const appliedTotal = (existing?.appliedTotal ?? 0) + progress.applied
    const skippedTotal = (existing?.skippedTotal ?? 0) + progress.skipped
    const report = summarizeReport(pkg, {
      ...progress,
      applied: appliedTotal,
      skipped: skippedTotal,
    }, cascade)

    const now = serverNow()
    pkg.conflicts = progress.conflicts
    pkg.processed = failed ? progress.failureAt! : pkg.processed

    let status: StoredReceipt['status']
    if (failed) {
      status = 'partial'
      pkg.status = 'partial'
      audit(server, {
        action: '批次写入中断',
        target: `离线包 ${pkg.id}`,
        operator: '系统',
        detail: `前 ${pkg.processed}/${pkg.changes.length} 批已落库，第 ${pkg.processed + 1} 批写入失败，已保留现场可恢复。`,
      })
    } else if (progress.conflicts.length > 0) {
      status = 'conflict'
      pkg.status = 'conflict'
      audit(server, {
        action: '回网合并离线包',
        target: `离线包 ${pkg.id}`,
        operator: incoming.author,
        detail: `应用 ${report.applied} 项、跳过 ${report.skipped} 项，${progress.conflicts.length} 个字段两端同时修改，保留两版待复核。`,
      })
    } else {
      status = 'merged'
      pkg.status = 'merged'
      pkg.mergedAt = now
      audit(server, {
        action: '回网合并离线包',
        target: `离线包 ${pkg.id}`,
        operator: incoming.author,
        detail: `应用 ${report.applied} 项、跳过 ${report.skipped} 项，无冲突合并完成。`,
      })
    }
    if (existing && startProcessed > 0 && progress.applied + progress.skipped > 0) {
      audit(server, {
        action: '恢复批次续传',
        target: `离线包 ${pkg.id}`,
        operator: incoming.author,
        detail: `从第 ${startProcessed + 1} 批继续写入，本次处理 ${progress.applied + progress.skipped} 项。`,
      })
    }

    pkg.report = report
    pkg.submittedAt = existing?.acceptedAt ?? now

    const receipt: StoredReceipt = {
      packageId: pkg.id,
      author: pkg.author,
      status,
      processed: pkg.processed,
      total: pkg.changes.length,
      acceptedAt: existing?.acceptedAt ?? now,
      updatedAt: now,
      report,
      serverPackage: pkg,
      appliedTotal,
      skippedTotal,
    }
    server.receipts[pkg.id] = receipt
    saveServerState(server)
    savePackage(pkg)

    return ok({} as AxiosRequestConfig, {
      state: server.state,
      receipt: stripReceipt(receipt),
      pkg,
      failed,
      message: failed
        ? `第 ${pkg.processed + 1} 批写入失败，前 ${pkg.processed} 批已完成并持久化。`
        : undefined,
    })
  } finally {
    inFlight.delete(incoming.id)
  }
}

function stripReceipt(receipt: StoredReceipt): ServerPackageReceipt {
  const { serverPackage: _pkg, appliedTotal: _a, skippedTotal: _s, ...rest } = receipt
  return rest
}

/** 冲突复核裁定：选择现场版或调度端版写入，重算级联 */
function handleResolve(server: SyncServerState, payload: MockRequest): AxiosResponse {
  const receipts = Object.values(server.receipts) as StoredReceipt[]
  let target: { receipt: StoredReceipt; conflict: FieldConflict } | undefined
  for (const receipt of receipts) {
    const conflict = receipt.serverPackage.conflicts.find((item) => item.id === payload.conflictId)
    if (conflict) {
      target = { receipt, conflict }
      break
    }
  }
  if (!target) throw new Error('未找到待复核冲突')
  const { receipt, conflict } = target
  if (conflict.status === 'resolved') {
    throw new Error('该冲突已完成复核，不能重复裁定')
  }

  const entity = entityOf(server.state, conflict.entityType, conflict.entityId)
  if (!entity) throw new Error('冲突对应实体已不存在')

  const chosen = payload.resolution === 'local' ? conflict.localValue : conflict.serverValue
  ;(entity as unknown as Record<string, MergeFieldValue>)[conflict.field] = chosen
  entity.rev = (entity.rev ?? 1) + 1
  if ('updatedAt' in entity) entity.updatedAt = serverNow()
  server.state.headRev = (server.state.headRev ?? 0) + 1

  conflict.status = 'resolved'
  conflict.resolution = payload.resolution
  conflict.resolvedAt = serverNow()
  conflict.resolvedBy = payload.operator ?? '当前用户'

  const changedIds = conflict.entityType === 'setting' ? [conflict.entityId] : []
  const cascade = recomputeAfterSettingChange(server.state, changedIds)

  audit(server, {
    action: '冲突复核裁定',
    target: conflict.label,
    operator: payload.operator ?? '当前用户',
    detail: `采用${payload.resolution === 'local' ? '现场离线版' : '调度端版'}（${conflict.field} = ${chosen}），校核问题/场景/基线已级联重算。`,
  })

  const pending = receipt.serverPackage.conflicts.filter((item) => item.status === 'pending')
  if (pending.length === 0 && receipt.status !== 'merged') {
    receipt.status = 'merged'
    receipt.serverPackage.status = 'merged'
    receipt.serverPackage.mergedAt = serverNow()
    audit(server, {
      action: '离线包冲突闭环',
      target: `离线包 ${receipt.packageId}`,
      operator: payload.operator ?? '当前用户',
      detail: '全部冲突字段完成复核，离线包合并闭环。',
    })
  }
  receipt.updatedAt = serverNow()
  if (receipt.serverPackage.report) {
    const updatedReport = { ...receipt.serverPackage.report, cascade }
    receipt.serverPackage.report = updatedReport
    receipt.report = updatedReport
  }
  saveServerState(server)
  savePackage(receipt.serverPackage)

  return ok({} as AxiosRequestConfig, {
    state: server.state,
    receipt: stripReceipt(receipt),
    pkg: receipt.serverPackage,
  })
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 220))
  const payload = JSON.parse((config.data as string | undefined) ?? '{}') as MockRequest

  if (config.url === '/state' && config.method === 'get') {
    return ok(config, loadState())
  }
  if (config.url === '/state' && config.method === 'post') {
    const next = payload.state ?? loadState()
    saveState(next)
    return ok(config, next)
  }
  if (config.url === '/state/patch' && config.method === 'post') {
    const state = { ...loadState(), ...payload.patch }
    saveState(state)
    return ok(config, state)
  }

  // --- 离线协同 / 调度端权威状态 ---
  if (config.url === '/sync/server' && config.method === 'get') {
    return ok(config, loadServerState())
  }

  if (config.url === '/sync/pull' && config.method === 'post') {
    const server = loadServerState()
    return ok(config, { state: server.state, receipts: server.receipts })
  }

  if (config.url === '/sync/merge' && config.method === 'post') {
    const server = loadServerState()
    return handleMerge(server, payload)
  }

  if (config.url === '/sync/resolve' && config.method === 'post') {
    const server = loadServerState()
    return handleResolve(server, payload)
  }

  if (config.url === '/sync/dispatch-change' && config.method === 'post') {
    const server = loadServerState()
    const setting = server.state.settings.find((item) => item.id === payload.settingId)
    if (!setting || !payload.field) throw new Error('未指定调度端修改目标')
    const before = (setting as unknown as Record<string, unknown>)[payload.field]
    ;(setting as unknown as Record<string, MergeFieldValue>)[payload.field] =
      payload.value as MergeFieldValue
    setting.rev = (setting.rev ?? 1) + 1
    setting.updatedAt = serverNow()
    server.state.headRev = (server.state.headRev ?? 0) + 1
    const cascade = recomputeAfterSettingChange(server.state, [setting.id])
    audit(server, {
      action: '调度端定值修改',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: payload.operator ?? '调度值班员',
      detail: `${payload.field}：${before} → ${payload.value}；已触发校核问题/场景/基线重算。`,
    })
    saveServerState(server)
    return ok(config, { state: server.state, cascade })
  }

  if (config.url === '/sync/reflect' && config.method === 'post') {
    // 在线编辑后把本地状态镜像为权威状态；调度端更新过则拒绝覆盖
    const server = loadServerState()
    const local = payload.state
    if (!local) throw new Error('缺少本地状态')
    if ((server.state.headRev ?? 0) > (local.headRev ?? 0)) {
      return ok(
        config,
        {
          stale: true,
          message: '调度端已有更新修订，需先拉取合并后再提交本地修改，避免覆盖调度改动。',
          serverHeadRev: server.state.headRev,
        },
        409,
      )
    }
    server.state = clone(local)
    saveServerState(server)
    return ok(config, { state: server.state })
  }

  if (config.url === '/actions/reset' && config.method === 'post') {
    return ok(config, resetState())
  }
  if (config.url === '/actions/export' && config.method === 'post') {
    return ok(config, { content: exportSettingsText(loadState()) })
  }
  return Promise.reject(new Error(`未实现的本地接口：${config.method} ${config.url}`))
}

export const http = axios.create({
  baseURL: '/api',
  adapter: mockAdapter,
  headers: { 'Content-Type': 'application/json' },
})

export async function fetchState(): Promise<AppState> {
  const response = await http.get<AppState>('/state')
  return response.data
}

export async function persistState(state: AppState): Promise<AppState> {
  const response = await http.post<AppState>('/state', { state })
  return response.data
}

export async function patchState(patch: Partial<AppState>): Promise<AppState> {
  const response = await http.post<AppState>('/state/patch', { patch })
  return response.data
}

export async function resetMockState(): Promise<AppState> {
  const response = await http.post<AppState>('/actions/reset')
  return response.data
}

export async function exportSettings(): Promise<string> {
  const response = await http.post<{ content: string }>('/actions/export')
  return response.data.content
}

// --- 协同接口 ---------------------------------------------------------------

export interface MergeResponse {
  state: AppState
  receipt: ServerPackageReceipt
  pkg: OfflinePackage
  failed?: boolean
  message?: string
}

export async function pullServer(): Promise<{
  state: AppState
  receipts: Record<string, ServerPackageReceipt>
}> {
  const response = await http.post<{ state: AppState; receipts: Record<string, ServerPackageReceipt> }>(
    '/sync/pull',
    {},
  )
  return response.data
}

export async function submitOfflinePackage(
  pkg: OfflinePackage,
  failBefore?: number,
): Promise<MergeResponse> {
  const response = await http.post<MergeResponse>('/sync/merge', { pkg, failBefore })
  return response.data
}

export async function resolveConflict(
  conflictId: string,
  resolution: 'local' | 'server',
  operator = '当前用户',
): Promise<MergeResponse> {
  const response = await http.post<MergeResponse>('/sync/resolve', {
    conflictId,
    resolution,
    operator,
  })
  return response.data
}

export async function simulateDispatchChange(input: {
  settingId: string
  field: string
  value: MergeFieldValue
  operator?: string
}): Promise<{ state: AppState }> {
  const response = await http.post<{ state: AppState }>('/sync/dispatch-change', input)
  return response.data
}

export async function reflectLocalState(
  state: AppState,
): Promise<{ state: AppState } | { stale: true; message: string }> {
  const response = await http.post('/sync/reflect', { state })
  return response.data as { state: AppState }
}

export { loadPackage, clearPackage, savePackage }
