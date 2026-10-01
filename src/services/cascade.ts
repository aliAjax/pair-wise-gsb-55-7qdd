import type {
  AppState,
  BaselineVersion,
  CascadeReport,
  FaultScenario,
  ProtectionSetting,
  ValidationIssue,
} from '@/types/domain'
import { validateSettings } from './validation'
import { driftedSettingIds } from './revision'

/**
 * 场景是否引用了发生变化的定值：
 * 动作序列涉及的保护，或停电/故障设备上的保护被改动，即判定场景结论失效。
 */
function affectedScenarioIds(
  scenarios: FaultScenario[],
  state: AppState,
  changedIds: string[],
): Set<string> {
  if (!changedIds.length) return new Set()
  const changed = new Set(changedIds)
  const changedSettings = state.settings.filter((item) => changed.has(item.id))
  const touchedRelays = new Set(changedSettings.map((item) => item.relayId))
  const touchedDevices = new Set(changedSettings.map((item) => item.protectedDeviceId))

  const result = new Set<string>()
  scenarios.forEach((scenario) => {
    const stepRelay = scenario.steps.some((step) => touchedRelays.has(step.relayId))
    const outageHit = scenario.outageDevices.some((id) => touchedDevices.has(id))
    const faultHit = touchedDevices.has(scenario.faultDeviceId)
    if (stepRelay || outageHit || faultHit) result.add(scenario.id)
  })
  return result
}

/**
 * 基线漂移判定：快照定值与当前定值不一致。
 * 会签中的基线直接失效（需重算重提），已锁定基线保留快照但标记漂移（审批页/执行页给出告警）。
 */
function driftBaselines(baselines: BaselineVersion[], settings: ProtectionSetting[]): string[] {
  const drifted: string[] = []
  baselines.forEach((baseline) => {
    const ids = driftedSettingIds(settings, baseline.snapshot)
    const isDrifted = ids.length > 0
    if (isDrifted && !baseline.drifted) {
      baseline.drifted = true
      if (baseline.status === 'reviewing') baseline.status = 'invalid'
      drifted.push(baseline.id)
    } else if (!isDrifted && baseline.drifted && baseline.status === 'invalid') {
      // 定值回退到快照后，可恢复会签
      baseline.drifted = false
      baseline.status = 'reviewing'
    }
  })
  return drifted
}

/**
 * 定值一变，校核问题、故障场景和基线版本失效重算。
 * - 校核问题：全量重算，保留同 id 问题的处理状态（回复中/已关闭），其余回到待处理。
 * - 场景：引用了变动定值且已有结论（会签中/已批准/已锁定）的降级为失效待重算。
 * - 基线：快照漂移时会签中置为失效，已锁定标记漂移。
 */
export function recomputeAfterSettingChange(
  state: AppState,
  changedSettingIds: string[],
): CascadeReport {
  const previousIssues = new Map(state.issues.map((issue) => [issue.id, issue]))
  const nextIssues: ValidationIssue[] = validateSettings(state.settings, state.devices)
  state.issues = nextIssues.map((issue) => {
    const previous = previousIssues.get(issue.id)
    return previous
      ? { ...issue, status: previous.status }
      : issue
  })

  const invalidScenarios = affectedScenarioIds(state.scenarios, state, changedSettingIds)
  state.scenarios = state.scenarios.map((scenario) => {
    if (
      invalidScenarios.has(scenario.id) &&
      ['reviewing', 'approved', 'locked'].includes(scenario.status)
    ) {
      return { ...scenario, status: 'invalid' as const }
    }
    return scenario
  })

  const driftedBaselines = driftBaselines(state.baselines, state.settings)

  return {
    issues: state.issues.length,
    invalidScenarioIds: [...invalidScenarios],
    driftedBaselineIds: driftedBaselines,
  }
}

/** 场景内容变化后重新核对其结论状态（供合并/重算入口调用） */
export function revalidateScenario(scenario: FaultScenario, settings: ProtectionSetting[]): void {
  const stillReferenced = scenario.steps.every((step) =>
    settings.some((item) => item.relayId === step.relayId),
  )
  if (scenario.status === 'invalid' && stillReferenced) scenario.status = 'reviewing'
}
