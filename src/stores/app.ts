import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ExecutionRecord,
  FieldValue,
  MergeConflict,
  OfflineItem,
  OfflinePackage,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  SettingField,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import {
  issuesPreservingState,
  isBaselineStale,
  isScenarioStale,
  settingsChecksum,
} from '@/services/revision'
import { newId, nowIso, resolveConflict } from '@/services/merge'
import {
  applyDispatchChange as dispatchChangeApi,
  importLegacyBatch as importLegacyApi,
  persistState,
  submitPackage as submitPackageApi,
} from '@/api/client'

const operatorName = '当前用户'

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')
  const backfillNotice = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const baselines = computed(() => data.value.baselines)
  const offlinePackages = computed(() => data.value.offlinePackages)
  const mergeConflicts = computed(() => data.value.mergeConflicts)
  const executionRecords = computed(() => data.value.executionRecords)
  const networkMode = computed(() => data.value.networkMode)

  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  const currentChecksum = computed(() => settingsChecksum(data.value.settings))

  /** 已批准/锁定场景中定值已变化、需要重新验证的场景。 */
  const staleScenarios = computed(() =>
    data.value.scenarios.filter((scenario) => isScenarioStale(scenario, currentChecksum.value)),
  )

  /** 会签中、快照已落后当前定值的基线；已锁定有效版本不参与失效。 */
  const staleBaselines = computed(() =>
    data.value.baselines.filter((baseline) => isBaselineStale(baseline, currentChecksum.value)),
  )

  const pendingConflicts = computed(() =>
    data.value.mergeConflicts.filter((conflict) => conflict.status === 'pending'),
  )

  const interruptedPackages = computed(() =>
    data.value.offlinePackages.filter(
      (pkg) => pkg.status === 'submitting' && pkg.items.some((item) => item.status === 'pending'),
    ),
  )

  /** 审批页与执行页共同读取的唯一有效版本来源。 */
  const effectiveVersion = computed(() => {
    const baseline = activeBaseline.value
    if (!baseline || baseline.status !== 'locked') return undefined
    return {
      baselineId: baseline.id,
      version: baseline.version,
      checksum: baseline.checksum,
      lockedAt: baseline.lockedAt,
      note: baseline.note,
      settingCount: baseline.snapshot.length,
      matchesCurrent: baseline.checksum === currentChecksum.value,
    }
  })

  function hydrate(payload: AppState | { state: AppState; backfillNote?: string }) {
    if ('state' in payload) {
      data.value = payload.state
      backfillNotice.value = payload.backfillNote ?? ''
    } else {
      data.value = payload
    }
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({ ...entry, id: newId('audit'), createdAt: nowIso() })
  }

  function recalcAfterSettingChange(reason: string, settingIds: string[]) {
    data.value.issues = issuesPreservingState(
      validateSettings(data.value.settings, data.value.devices),
      data.value.issues,
    )
    const staleScenarioNames = staleScenarios.value.map((scenario) => scenario.name)
    const staleBaselineVersions = staleBaselines.value.map((baseline) => baseline.version)
    const detailParts = [
      reason,
      `涉及定值 ${settingIds.length} 条；校核问题已按新定值重算。`,
    ]
    if (staleScenarioNames.length) detailParts.push(`场景失效待复验：${staleScenarioNames.join('、')}。`)
    if (staleBaselineVersions.length) detailParts.push(`会签基线快照失效：${staleBaselineVersions.join('、')}。`)
    appendAudit({
      action: '定值变更级联重算',
      target: settingIds.join(', ') || '全部定值',
      operator: operatorName,
      detail: detailParts.join(''),
    })
  }

  async function addDevice(device: Omit<Device, 'id' | 'revision'>) {
    const item: Device = { ...device, id: newId('device'), revision: 1 }
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: operatorName,
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV，台账修订号 rev 1。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    const previous = data.value.devices[index]
    data.value.devices[index] = {
      ...device,
      operationModes: [...device.operationModes],
      revision: previous.revision + 1,
    }
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: operatorName,
      detail: `运行状态调整为 ${device.status}，台账修订号自增为 rev ${data.value.devices[index].revision}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const existed = index >= 0
    const previous = existed ? data.value.settings[index] : undefined
    const next: ProtectionSetting = {
      ...setting,
      revision: previous ? previous.revision + 1 : 1,
      updatedAt: nowIso(),
    }
    if (existed) data.value.settings[index] = next
    else data.value.settings.push(next)
    appendAudit({
      action: existed ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: operatorName,
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s，修订号 rev ${next.revision}。`,
    })
    recalcAfterSettingChange(
      existed ? '在线编辑保存触发级联。' : '新增定值触发级联。',
      [next.id],
    )
    await commit('定值已保存')
  }

  async function runValidation() {
    data.value.issues = validateSettings(data.value.settings, data.value.devices)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: operatorName,
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
      operator: operatorName,
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({ ...comment, id: newId('comment'), createdAt: nowIso() })
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
    scenario.status = status
    // 批准场景即把当前定值校验码固化为验证依据；定值再变则自动判失效。
    if (status === 'approved' || status === 'locked') {
      scenario.basisChecksum = currentChecksum.value
      scenario.reverifiedAt = nowIso()
    }
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: operatorName,
      detail: `状态更新为 ${status}，验证依据校验码 ${scenario.basisChecksum ?? '无'}。`,
    })
    await commit('场景状态已更新')
  }

  /** 定值变化后对失效场景重新验证，刷新依据校验码。 */
  async function reverifyScenario(id: string) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.basisChecksum = currentChecksum.value
    scenario.reverifiedAt = nowIso()
    if (scenario.status === 'draft' || scenario.status === 'reviewing') scenario.status = 'approved'
    appendAudit({
      action: '场景重新验证',
      target: scenario.name,
      operator: operatorName,
      detail: `依据最新定值校验码 ${currentChecksum.value} 重新核对动作序列与停电范围，失效标记解除。`,
    })
    await commit('场景已重新验证')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: newId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: nowIso(),
    }
    data.value.scenarios.unshift(item)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: operatorName,
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: newId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: nowIso(),
      createdBy: operatorName,
      note,
      snapshot: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      checksum: currentChecksum.value,
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: operatorName,
      detail: `${note}；快照校验码 ${baseline.checksum}，定值修订号已一并冻结。`,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  /** 会签中基线快照落后时按当前定值重建，基线版本不变、重新会签。 */
  async function rebuildBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline || baseline.status === 'locked') return
    baseline.snapshot = JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[]
    baseline.checksum = currentChecksum.value
    baseline.rebuiltAt = nowIso()
    appendAudit({
      action: '重建基线快照',
      target: baseline.version,
      operator: operatorName,
      detail: `定值已变化，会签中基线按当前定值重新冻结快照，新校验码 ${baseline.checksum}，需重新会签。`,
    })
    await commit('基线快照已重建')
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    if (baseline.checksum !== currentChecksum.value) {
      throw new Error('基线快照已落后当前定值，请先重建快照并重新会签')
    }
    baseline.status = 'locked'
    baseline.lockedAt = nowIso()
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定有效版本',
      target: baseline.version,
      operator: operatorName,
      detail: `校验码 ${baseline.checksum}；该版本成为审批页与执行页共同的唯一有效版本。`,
    })
    await commit('基线已锁定为有效版本')
  }

  async function setNetworkMode(mode: AppState['networkMode']) {
    if (data.value.networkMode === mode) return
    const previous = data.value.networkMode
    data.value.networkMode = mode
    appendAudit({
      action: mode === 'offline' ? '进入断网作业' : '恢复联网',
      target: '网络状态',
      operator: operatorName,
      detail: `网络状态由 ${previous === 'offline' ? '断网' : '联网'} 切换为 ${mode === 'offline' ? '断网' : '联网'}。`,
    })
    await commit(mode === 'offline' ? '已进入断网作业模式' : '已恢复联网')
  }

  function packageCode() {
    const serial = String(data.value.offlinePackages.length + 1).padStart(3, '0')
    return `OFF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${serial}`
  }

  function createOfflinePackage(input: { site: string; note: string; operator: string }) {
    const pkg: OfflinePackage = {
      id: newId('pkg'),
      code: packageCode(),
      operator: input.operator || '现场工程师',
      site: input.site,
      note: input.note,
      idempotencyKey: '',
      status: 'draft',
      baseChecksum: currentChecksum.value,
      items: [],
      createdAt: nowIso(),
    }
    pkg.idempotencyKey = `idem-${pkg.code}`
    data.value.offlinePackages.unshift(pkg)
    return pkg
  }

  function addOfflineItem(
    packageId: string,
    input: { settingId: string; field: SettingField; offlineValue: FieldValue },
  ) {
    const pkg = data.value.offlinePackages.find((item) => item.id === packageId)
    const setting = data.value.settings.find((item) => item.id === input.settingId)
    if (!pkg || !setting) return
    const existingIndex = pkg.items.findIndex(
      (item) => item.settingId === input.settingId && item.field === input.field,
    )
    const item: OfflineItem = {
      id: newId('offitem'),
      settingId: input.settingId,
      field: input.field,
      baseValue: setting[input.field] as FieldValue,
      offlineValue: input.offlineValue,
      status: 'pending',
    }
    if (existingIndex >= 0) pkg.items[existingIndex] = item
    else pkg.items.push(item)
  }

  function removeOfflineItem(packageId: string, itemId: string) {
    const pkg = data.value.offlinePackages.find((item) => item.id === packageId)
    if (!pkg || pkg.status !== 'draft') return
    pkg.items = pkg.items.filter((item) => item.id !== itemId)
  }

  async function sealOfflinePackage(packageId: string) {
    const pkg = data.value.offlinePackages.find((item) => item.id === packageId)
    if (!pkg || !pkg.items.length) return
    pkg.status = 'sealed'
    pkg.sealedAt = nowIso()
    appendAudit({
      action: '封存离线包',
      target: pkg.code,
      operator: pkg.operator,
      detail: `现场 ${pkg.site} 封存 ${pkg.items.length} 项离线修改，基底校验码 ${pkg.baseChecksum}，幂等键 ${pkg.idempotencyKey}。`,
      traceId: pkg.code,
    })
    await commit('离线包已封存，等待回网合并')
  }

  /**
   * 回网提交：服务端做同包幂等与并发判定（只放行一份），
   * 并逐项落盘；可通过 failAtItem 注入写入失败，之后调用本方法即可断点续传。
   */
  async function submitOfflinePackage(packageId: string, failAtItem?: number, clientId?: string) {
    const id =
      clientId ??
      `client-${data.value.offlinePackages.find((item) => item.id === packageId)?.operator ?? 'x'}`
    const response = await submitPackageApi({ packageId, clientId: id, failAtItem })
    data.value = response.state
    return response.result
  }

  async function resolveMergeConflict(conflictId: string, choice: 'offline' | 'dispatch') {
    const result = resolveConflict(data.value, conflictId, choice, operatorName)
    data.value = result.state
    await commit('冲突复核裁决已写入')
  }

  async function applyDispatchChange(input: {
    settingId: string
    field: keyof ProtectionSetting
    value: FieldValue
    operator?: string
  }) {
    const state = await dispatchChangeApi(input)
    data.value = state
  }

  async function importLegacyBatch() {
    const state = await importLegacyApi()
    data.value = state
  }

  /** 审批页与执行页共用的下发动作：严格使用有效版本快照。 */
  async function executeEffectiveVersion(note: string) {
    const effective = effectiveVersion.value
    if (!effective) throw new Error('尚无已锁定的有效版本，请先在会签页批准锁定基线')
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能下发有效版本')
    }
    if (!effective.matchesCurrent) {
      throw new Error('当前定值与有效版本不一致，请先重建/批准新版本基线，再执行下发')
    }
    const record: ExecutionRecord = {
      id: newId('exec'),
      baselineId: effective.baselineId,
      version: effective.version,
      checksum: effective.checksum,
      operator: operatorName,
      note,
      createdAt: nowIso(),
    }
    data.value.executionRecords.unshift(record)
    appendAudit({
      action: '执行有效版本下发',
      target: `${effective.version}`,
      operator: operatorName,
      detail: `按有效版本快照（校验码 ${effective.checksum}）向现场装置下发 ${effective.settingCount} 条定值。说明：${note || '无'}`,
      traceId: `exec-${effective.version}`,
    })
    await commit('有效版本已下发')
    return record
  }

  async function recordExport(format: string, count: number) {
    const effective = effectiveVersion.value
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: operatorName,
      detail: `导出 ${count} 条保护定值，有效版本 ${effective ? `${effective.version} (${effective.checksum})` : '未发布'}。`,
    })
    await commit('导出记录已写入审计')
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    backfillNotice,
    devices,
    settings,
    issues,
    scenarios,
    baselines,
    offlinePackages,
    mergeConflicts,
    executionRecords,
    networkMode,
    activeBaseline,
    currentChecksum,
    staleScenarios,
    staleBaselines,
    pendingConflicts,
    interruptedPackages,
    effectiveVersion,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    reverifyScenario,
    addScenario,
    createBaseline,
    rebuildBaseline,
    approveBaseline,
    setNetworkMode,
    createOfflinePackage,
    addOfflineItem,
    removeOfflineItem,
    sealOfflinePackage,
    submitOfflinePackage,
    resolveMergeConflict,
    applyDispatchChange,
    importLegacyBatch,
    executeEffectiveVersion,
    recordExport,
    reset,
  }
})

export type MergeConflictRecord = MergeConflict
