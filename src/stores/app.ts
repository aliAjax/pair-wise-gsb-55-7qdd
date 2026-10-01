import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { persistState, resetMockState } from '@/api/client'
import { REV_FIELDS, checksum } from '@/services/revision'
import { recomputeAfterSettingChange, revalidateScenario } from '@/services/cascade'
import { useSyncStore } from './sync'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const sync = useSyncStore()

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )
  /**
   * 当前唯一有效版本：审批页（会签与基线）和执行页（定值执行）都从这里取，
   * 杜绝两页各自缓存造成的“批的是一版、执行另一版”。
   */
  const effectiveVersion = computed(() => {
    const baseline = activeBaseline.value
    if (!baseline) return undefined
    return {
      id: baseline.id,
      version: baseline.version,
      checksum: baseline.checksum,
      drifted: !!baseline.drifted,
      lockedAt: baseline.lockedAt,
      snapshotCount: baseline.snapshot.length,
    }
  })

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  /** 回网拉取/合并后，用调度端权威状态整体对齐本地工作台 */
  function applyServerState(state: AppState) {
    data.value = JSON.parse(JSON.stringify(state)) as AppState
    hydrated.value = true
  }

  /**
   * 本地落盘。在线时同时镜像到调度端权威版本；
   * 若调度端已有更新修订（headRev 更大），返回 stale 由 UI 引导先合并。
   */
  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
      if (sync.online) {
        const reflected = await sync.reflect(saved)
        if ('stale' in reflected) {
          lastMessage.value = reflected.message
          return { stale: true as const, message: reflected.message }
        }
      }
      return { stale: false as const }
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  /** 断网期间只允许现场改定值，台账/基线等流程必须回网后办理 */
  function assertOnlineFor(action: string) {
    if (!sync.online) {
      throw new Error(`链路断开中，${action}需要回网后在调度协同下办理；当前仅允许现场修改定值。`)
    }
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    assertOnlineFor('新增设备台账')
    const item = { ...device, id: createId('device'), rev: (data.value.headRev ?? 0) + 1 }
    data.value.headRev = (data.value.headRev ?? 0) + 1
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV，修订号 rev=${item.rev}。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    assertOnlineFor('变更设备台账')
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    data.value.devices[index] = {
      ...device,
      operationModes: [...device.operationModes],
      rev: (device.rev ?? 1) + 1,
    }
    data.value.headRev = (data.value.headRev ?? 0) + 1
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}，修订号 rev=${data.value.devices[index].rev}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const previous = index >= 0 ? data.value.settings[index] : undefined
    const changedFields = previous
      ? REV_FIELDS.filter((field) => previous[field] !== setting[field])
      : REV_FIELDS.slice()
    const next: ProtectionSetting = {
      ...setting,
      rev: previous ? (previous.rev ?? 1) + 1 : 1,
      updatedAt: now(),
    }
    if (index >= 0) data.value.settings[index] = next
    else data.value.settings.push(next)
    data.value.headRev = (data.value.headRev ?? 0) + 1

    if (!sync.online && previous) {
      // 断网修改：逐字段记入离线包，回网后按字段三方合并
      changedFields.forEach((field) => {
        sync.recordSettingChange(
          data.value,
          next,
          field,
          next[field] as string | number | boolean,
        )
      })
      const cascade = recomputeAfterSettingChange(data.value, previous ? [previous.id] : [])
      appendAudit({
        action: '断网修改定值',
        target: `${setting.relayId} ${setting.stage} 段`,
        operator: '现场工程师',
        detail: `离线修改 ${changedFields.length} 个字段（电流 ${setting.currentA}A，时限 ${setting.timeS}s，rev=${next.rev}）；本地校核问题 ${cascade.issues} 条，待回网合并后复核。`,
      })
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = '离线定值已写入现场包，回网后合并'
      return { stale: false as const, offline: true as const, changedFields }
    }

    const cascade = recomputeAfterSettingChange(data.value, previous ? [previous.id] : [])
    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s，rev=${next.rev}；级联重算：问题 ${cascade.issues} 条、失效场景 ${cascade.invalidScenarioIds.length} 个、漂移基线 ${cascade.driftedBaselineIds.length} 个。`,
    })
    const result = await commit('定值已保存，校核问题/场景/基线已重算')
    return { ...result, offline: false as const, changedFields, cascade }
  }

  async function runValidation() {
    data.value.issues = validateSettings(data.value.settings, data.value.devices)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交')
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    if (status === 'reviewing' && scenario.status === 'invalid') {
      revalidateScenario(scenario, data.value.settings)
      scenario.rev = (scenario.rev ?? 1) + 1
    } else {
      scenario.status = status
      scenario.rev = (scenario.rev ?? 1) + 1
    }
    data.value.headRev = (data.value.headRev ?? 0) + 1
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${scenario.status}，修订号 rev=${scenario.rev}。`,
    })
    await commit('场景状态已更新')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    assertOnlineFor('新建故障场景')
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
      rev: (data.value.headRev ?? 0) + 1,
    }
    data.value.headRev = (data.value.headRev ?? 0) + 1
    data.value.scenarios.unshift(item)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  async function createBaseline(note: string) {
    assertOnlineFor('创建基线上会签')
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      checksum: checksum(data.value.settings),
      rev: (data.value.headRev ?? 0) + 1,
      drifted: false,
    }
    data.value.headRev = (data.value.headRev ?? 0) + 1
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: `${note}（rev=${baseline.rev}，校验码 ${baseline.checksum}）`,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    if (baseline.status === 'invalid' || baseline.drifted) {
      throw new Error('该基线快照已随定值变更失效，请按当前定值重算并重新上会签')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    baseline.rev = (baseline.rev ?? 1) + 1
    data.value.headRev = (data.value.headRev ?? 0) + 1
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}，rev=${baseline.rev}；该版本为审批页与执行页唯一有效版本。`,
    })
    await commit('基线已锁定')
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `导出 ${count} 条保护定值。`,
    })
    await commit('导出记录已写入审计')
  }

  /** 执行页执行定值前的版本一致性核对（不修改数据，只返回结论） */
  function verifyExecution() {
    const version = effectiveVersion.value
    if (!version) {
      return { ok: false, reason: '没有已锁定的有效基线版本，禁止执行' }
    }
    if (version.drifted) {
      return {
        ok: false,
        reason: `有效版本 ${version.version} 已随定值变更漂移（锁定校验码 ${version.checksum}），请先重新审批新版本`,
      }
    }
    const currentChecksum = checksum(data.value.settings)
    if (currentChecksum !== version.checksum) {
      return {
        ok: false,
        reason: `当前定值校验码 ${currentChecksum} 与有效版本 ${version.version} 的 ${version.checksum} 不一致`,
      }
    }
    return { ok: true, version, currentChecksum }
  }

  async function recordExecution() {
    const verification = verifyExecution()
    if (!verification.ok) throw new Error(verification.reason)
    appendAudit({
      action: '按有效版本执行定值',
      target: verification.version!.version,
      operator: '当前用户',
      detail: `执行前校验码核对一致（${verification.version!.checksum}，共 ${verification.version!.snapshotCount} 条定值）。`,
    })
    await commit('定值执行已记录审计')
    return verification
  }

  async function reset() {
    const initial = await resetMockState()
    hydrate(initial)
    sync.online = true
    sync.closePackage()
    await sync.pull()
    lastMessage.value = '已恢复演示数据'
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    devices,
    settings,
    issues,
    scenarios,
    activeBaseline,
    effectiveVersion,
    hydrate,
    applyServerState,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    recordExport,
    verifyExecution,
    recordExecution,
    reset,
  }
})
