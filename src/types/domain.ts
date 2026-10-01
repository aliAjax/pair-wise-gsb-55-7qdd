export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

/** 参与三方合并与差异比较的定值字段。 */
export type SettingField =
  | 'currentA'
  | 'timeS'
  | 'direction'
  | 'sensitivity'
  | 'recloseEnabled'
  | 'recloseDelayS'
  | 'startCondition'

export type FieldValue = string | number | boolean

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
  /** 台账修订号，旧数据首次导入时回填为 1。 */
  revision: number
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
  /** 定值修订号，任何来源的写入成功都会自增，旧数据首次导入时回填为 1。 */
  revision: number
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
  /** 批准/重新验证通过时的定值校验码，与当前校验码不一致即判为失效。 */
  basisChecksum?: string
  reverifiedAt?: string
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
  /** 会签中基线按当前定值重建快照的时间。 */
  rebuiltAt?: string
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
  /** 审校链追踪标识，离线包合并/冲突/恢复全流程使用同一个包号。 */
  traceId?: string
}

/** 离线包内单条定值修改。 */
export interface OfflineItem {
  id: string
  settingId: string
  field: SettingField
  baseValue: FieldValue
  offlineValue: FieldValue
  status: 'pending' | 'applied' | 'conflict' | 'skipped'
  message?: string
}

export type OfflinePackageStatus = 'draft' | 'sealed' | 'submitting' | 'merged'

/** 断网期间在现场封存的离线修改包。 */
export interface OfflinePackage {
  id: string
  code: string
  operator: string
  site: string
  note: string
  /** 幂等键：同一份包无论由谁、提交几次，全链路只放行一份。 */
  idempotencyKey: string
  status: OfflinePackageStatus
  baseChecksum: string
  items: OfflineItem[]
  createdAt: string
  sealedAt?: string
  submittedAt?: string
  mergedAt?: string
  lastError?: string
}

/** 两端改过同一字段时保留的两版待复核记录。 */
export interface MergeConflict {
  id: string
  packageId: string
  packageCode: string
  itemId: string
  settingId: string
  field: SettingField
  baseValue: FieldValue
  /** 现场离线版。 */
  offlineValue: FieldValue
  /** 回网时调度端已在库的版本。 */
  dispatchValue: FieldValue
  status: 'pending' | 'resolved-offline' | 'resolved-dispatch'
  resolvedBy?: string
  resolvedAt?: string
  createdAt: string
}

/** 提交锁的持久化形态；进行中的内存锁只存在适配器进程内。 */
export interface SubmissionLock {
  status: 'interrupted' | 'committed'
  clientId: string
  updatedAt: string
  attempts: number
}

/** 有效版本执行（定值下发）记录。 */
export interface ExecutionRecord {
  id: string
  baselineId: string
  version: string
  checksum: string
  operator: string
  note: string
  createdAt: string
}

export interface AppState {
  schemaVersion: number
  networkMode: 'online' | 'offline'
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  /** 当前有效（已锁定）基线，审批页与执行页共同的唯一版本来源。 */
  activeBaselineId?: string
  offlinePackages: OfflinePackage[]
  mergeConflicts: MergeConflict[]
  submissionLocks: Record<string, SubmissionLock>
  executionRecords: ExecutionRecord[]
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting | 'id'
  before: string | number | boolean
  after: string | number | boolean
}
