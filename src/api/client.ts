import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import type { AppState } from '@/types/domain'
import {
  effectiveVersionLabel,
  exportSettingsText,
  loadState,
  resetState,
  saveState,
  buildLegacyImportBatch,
} from '@/services/storage'
import { backfillAuditEntries, normalizeState, issuesPreservingState } from '@/services/revision'
import { newId, processPackage, type ProcessPackageResult } from '@/services/merge'
import { validateSettings } from '@/services/validation'

type MockRequest = {
  state?: AppState
  patch?: Partial<AppState>
  action?: 'reset' | 'export'
}

type AdapterPayload = MockRequest &
  SubmitPackagePayload & {
    settingId?: string
    field?: keyof AppState['settings'][number]
    value?: string | number | boolean
    operator?: string
  }

/** 可识别的业务冲突：同包重复/并发提交被拒时抛出，前端直接展示消息。 */
export class SyncError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
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

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** 进行中的提交锁：同一份包（幂等键）全进程只允许一个在途请求。 */
const inflight = new Map<string, string>()

export interface SubmitPackagePayload {
  packageId: string
  clientId: string
  /** 1 基序号：在第 N 个待写入项模拟写入失败，用于演示断点续传。 */
  failAtItem?: number
}

export interface SubmitPackageResponse {
  state: AppState
  result: ProcessPackageResult
  duplicated: boolean
}

function persist(state: AppState) {
  saveState(state)
  return state
}

const mockAdapter: AxiosAdapter = async (config) => {
  const payload = JSON.parse((config.data as string | undefined) ?? '{}') as AdapterPayload

  // 并发/重复提交判定必须在任何 await 之前完成，保证同包只放行一份。
  if (config.url === '/sync/submit' && config.method === 'post') {
    const current = loadState().state
    const pkg = current.offlinePackages.find((item) => item.id === payload.packageId)
    if (!pkg) return Promise.reject(new SyncError('PACKAGE_NOT_FOUND', '离线包不存在，无法提交。'))

    const lock = current.submissionLocks[pkg.idempotencyKey]
    const owner = inflight.get(pkg.idempotencyKey)
    if (owner && owner !== payload.clientId) {
      return Promise.reject(
        new SyncError(
          'INFLIGHT_OTHER_CLIENT',
          `同一份包 ${pkg.code} 正由另一会话提交，系统只放行一份，本次请求已拒绝。`,
        ),
      )
    }
    if (owner === payload.clientId) {
      return Promise.reject(
        new SyncError('DUPLICATE_INFLIGHT', `包 ${pkg.code} 仍在写入中，请勿重复提交，等待当前批次完成。`),
      )
    }
    if (pkg.status === 'merged' || lock?.status === 'committed') {
      return Promise.reject(
        new SyncError(
          'ALREADY_COMMITTED',
          `包 ${pkg.code} 已完成合并（幂等键 ${pkg.idempotencyKey}），重复提交被拦截，未产生第二份写入。`,
        ),
      )
    }

    inflight.set(pkg.idempotencyKey, payload.clientId)
    try {
      await delay(500)
      const latest = loadState().state
      const processed = processPackage(latest, pkg.id, {
        clientId: payload.clientId,
        failAtItem: payload.failAtItem,
      })
      persist(processed.state)
      if (processed.interrupted) {
        return ok(config, {
          state: processed.state,
          result: processed,
          duplicated: false,
        } satisfies SubmitPackageResponse,
          202,
        )
      }
      return ok(config, {
        state: processed.state,
        result: processed,
        duplicated: false,
      } satisfies SubmitPackageResponse)
    } finally {
      inflight.delete(pkg.idempotencyKey)
    }
  }

  await delay(180)

  if (config.url === '/bootstrap' && config.method === 'get') {
    return ok(config, loadState())
  }
  if (config.url === '/state' && config.method === 'get') {
    return ok(config, loadState().state)
  }
  if (config.url === '/state' && config.method === 'post') {
    const next = payload.state ?? loadState().state
    return ok(config, persist(next))
  }
  if (config.url === '/state/patch' && config.method === 'post') {
    const state = { ...loadState().state, ...payload.patch }
    return ok(config, persist(state))
  }
  if (config.url === '/actions/reset' && config.method === 'post') {
    return ok(config, resetState())
  }
  if (config.url === '/actions/export' && config.method === 'post') {
    const state = loadState().state
    return ok(config, { content: exportSettingsText(state), version: effectiveVersionLabel(state) })
  }

  // 模拟回网前调度端先改了同一字段（在线远端写入）。
  if (config.url === '/sync/dispatch-change' && config.method === 'post') {
    const loaded = loadState()
    const state: AppState = JSON.parse(JSON.stringify(loaded.state)) as AppState
    const setting = state.settings.find((item) => item.id === payload.settingId)
    if (!setting) return Promise.reject(new SyncError('SETTING_NOT_FOUND', '调度端找不到目标定值。'))
    const field = payload.field
    if (!field) return Promise.reject(new SyncError('BAD_REQUEST', '缺少修改字段'))
    const previous = setting[field]
    ;(setting as unknown as Record<string, unknown>)[field] = payload.value
    setting.revision += 1
    setting.updatedAt = new Date().toISOString()
    state.issues = issuesPreservingState(
      validateSettings(state.settings, state.devices),
      state.issues,
    )
    state.audit.unshift({
      id: newId('audit'),
      action: '调度端在线改定值',
      operator: payload.operator ?? '调度端',
      target: `${setting.relayId} ${setting.stage} 段`,
      detail: `字段 ${String(field)}：${String(previous)} → ${String(payload.value)}，修订号自增为 rev ${setting.revision}。`,
      createdAt: new Date().toISOString(),
    })
    return ok(config, persist(state))
  }

  // 模拟外部旧台账首次导入：数据缺修订号，落库前统一按首次导入回填 rev 1。
  if (config.url === '/sync/legacy-import' && config.method === 'post') {
    const loaded = loadState()
    const batch = buildLegacyImportBatch(loaded.state)
    const raw: Partial<AppState> = {
      ...loaded.state,
      devices: batch.devices,
      settings: batch.settings,
      audit: [...batch.audit, ...loaded.state.audit],
    }
    const normalized = normalizeState(raw)
    const next = normalized.state
    const backfillEntries = backfillAuditEntries(normalized, '当前用户')
    next.audit = [...backfillEntries, ...next.audit]
    next.issues = validateSettings(next.settings, next.devices)
    return ok(config, persist(next))
  }

  return Promise.reject(new Error(`未实现的本地接口：${config.method} ${config.url ?? ''}`))
}

export const http = axios.create({
  baseURL: '/api',
  adapter: mockAdapter,
  headers: { 'Content-Type': 'application/json' },
})

export async function fetchBootstrap() {
  const response = await http.get<Awaited<ReturnType<typeof loadState>>>('/bootstrap')
  return response.data
}

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

export async function exportSettings(): Promise<{ content: string; version: string }> {
  const response = await http.post<{ content: string; version: string }>('/actions/export')
  return response.data
}

export async function submitPackage(
  payload: SubmitPackagePayload,
): Promise<SubmitPackageResponse> {
  const response = await http.post<SubmitPackageResponse>('/sync/submit', payload)
  return response.data
}

export async function applyDispatchChange(payload: {
  settingId: string
  field: keyof AppState['settings'][number]
  value: string | number | boolean
  operator?: string
}): Promise<AppState> {
  const response = await http.post<AppState>('/sync/dispatch-change', payload)
  return response.data
}

export async function importLegacyBatch(): Promise<AppState> {
  const response = await http.post<AppState>('/sync/legacy-import', {})
  return response.data
}
