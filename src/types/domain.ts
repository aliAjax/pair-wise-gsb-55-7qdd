export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned' | 'invalid'

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
  /** 实体修订号；旧档案首次导入时可能缺失，由迁移逻辑回填为 1 */
  rev?: number
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
  /** 实体修订号；离线合并按字段做三方比对后递增 */
  rev?: number
}

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
  rev?: number
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  snapshot: ProtectionSetting[]
  checksum: string
  rev?: number
  /** 定值变更后快照与当前定值不再一致：会签中为失效，已锁定为版本漂移 */
  drifted?: boolean
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

/** 旧数据首次导入时回填修订号的迁移留痕 */
export interface LegacyMigrationReport {
  at: string
  backfilled: {
    devices: number
    settings: number
    scenarios: number
    baselines: number
  }
  headRev: number
  note: string
}

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  /** 全局修订流水号，随任意实体修订单调递增 */
  headRev?: number
  /** 最近一次旧数据修订号回填记录 */
  legacyMigration?: LegacyMigrationReport
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}

// ---------------------------------------------------------------------------
// 离线包 / 回网合并 / 冲突复核
// ---------------------------------------------------------------------------

export type SyncEntityType = 'setting' | 'device'
export type MergeFieldValue = string | number | boolean

/** 断网期间产生的一条字段级离线变更 */
export interface OfflineChange {
  id: string
  entityType: SyncEntityType
  entityId: string
  field: string
  /** 展示用：装置名 + 段位 */
  label: string
  baseValue: MergeFieldValue
  newValue: MergeFieldValue
  /** 变更基于的实体修订号 */
  baseRev: number
  createdAt: string
}

export type PackageStatus =
  | 'draft'
  | 'submitting'
  | 'merged'
  | 'partial'
  | 'conflict'
  | 'rejected'

/** 两端改过同一字段时保留的两版待复核记录 */
export interface FieldConflict {
  id: string
  changeId: string
  entityType: SyncEntityType
  entityId: string
  field: string
  label: string
  baseValue: MergeFieldValue
  /** 现场（离线包）值 */
  localValue: MergeFieldValue
  /** 调度端（服务器当前）值 */
  serverValue: MergeFieldValue
  status: 'pending' | 'resolved'
  resolution?: 'local' | 'server'
  resolvedAt?: string
  resolvedBy?: string
}

export interface CascadeReport {
  issues: number
  invalidScenarioIds: string[]
  driftedBaselineIds: string[]
}

export interface MergeReport {
  packageId: string
  total: number
  applied: number
  skipped: number
  conflicts: number
  duplicate?: boolean
  reason?: 'in-flight' | 'already-accepted'
  finishedAt: string
  cascade?: CascadeReport
}

/** 离线包：断网修改的可恢复载体，id 即提交幂等键 */
export interface OfflinePackage {
  id: string
  author: string
  baseHeadRev: number
  createdAt: string
  status: PackageStatus
  /** 断网瞬间冻结的字段基线值：setting:{id}:{field} -> value */
  baseSnapshot: Record<string, MergeFieldValue>
  /** 断网瞬间冻结的实体修订号：rev:setting:{id} -> rev */
  baseRevs: Record<string, number>
  changes: OfflineChange[]
  conflicts: FieldConflict[]
  /** 已完成的批次条目数（写入失败后的恢复游标） */
  processed: number
  report?: MergeReport
  submittedAt?: string
  mergedAt?: string
}

export type ServerReceiptStatus = 'merged' | 'partial' | 'conflict'

/** 服务端对每个离线包的接收回执：幂等去重与断点续传都依据它 */
export interface ServerPackageReceipt {
  packageId: string
  author: string
  status: ServerReceiptStatus
  processed: number
  total: number
  acceptedAt: string
  updatedAt: string
  report?: MergeReport
}

/** 调度端权威状态：业务数据 + 已接收包回执表 */
export interface SyncServerState {
  state: AppState
  receipts: Record<string, ServerPackageReceipt>
}
