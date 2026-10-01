import { assert } from 'node:console'
import type { AppState, OfflinePackage } from '../src/types/domain'
import { createInitialState } from '../src/data/mock'
import { backfillRevisions, REV_FIELDS } from '../src/services/revision'
import { applyBatch } from '../src/services/merge'
import { recomputeAfterSettingChange } from '../src/services/cascade'

let passed = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

const fresh = (): AppState => {
  const state = createInitialState()
  backfillRevisions(state, new Date().toISOString())
  return JSON.parse(JSON.stringify(state))
}

const makePackage = (state: AppState, edits: Array<{ id: string; field: string; value: string | number | boolean; base?: string | number | boolean }>): OfflinePackage => {
  const baseSnapshot: Record<string, string | number | boolean> = {}
  state.settings.forEach((item) => {
    REV_FIELDS.forEach((field) => {
      baseSnapshot[`setting:${item.id}:${field}`] = (item as unknown as Record<string, string | number | boolean>)[field]
    })
  })
  const changes = edits.map((edit, index) => {
    const setting = state.settings.find((item) => item.id === edit.id)!
    return {
      id: `chg-${index}`,
      entityType: 'setting' as const,
      entityId: edit.id,
      field: edit.field,
      label: `${setting.relayId} ${setting.stage}`,
      baseValue: edit.base ?? (setting as unknown as Record<string, string | number | boolean>)[edit.field],
      newValue: edit.value,
      baseRev: setting.rev ?? 1,
      createdAt: new Date().toISOString(),
    }
  })
  return {
    id: 'pkg-test-1',
    author: '现场',
    baseHeadRev: state.headRev ?? 0,
    createdAt: new Date().toISOString(),
    status: 'draft',
    baseSnapshot,
    baseRevs: Object.fromEntries(
      state.settings.map((item) => [`rev:setting:${item.id}`, item.rev ?? 1]),
    ),
    changes,
    conflicts: [],
    processed: 0,
  }
}

// 1. 旧数据回填
{
  const state = createInitialState()
  check('初始 mock 数据不带修订号', state.settings.some((item) => item.rev === undefined))
  const migrated = backfillRevisions(state, new Date().toISOString())
  check('回填发生', migrated !== null)
  check('全部定值 rev=1', state.settings.every((item) => item.rev === 1))
  check('headRev 已推进', (state.headRev ?? 0) >= state.settings.length)
  const again = backfillRevisions(state, new Date().toISOString())
  check('再次回填为空操作', again === null)
}

// 2. 干净合并：服务器未动 → 现场值应用
{
  const server = fresh()
  const pkg = makePackage(server, [{ id: 'set-l101-1', field: 'currentA', value: 9.9 }])
  const progress = applyBatch(server, pkg)
  check('应用 1 项', progress.applied === 1)
  check('无冲突', progress.conflicts.length === 0)
  check('现场值已写入', server.settings.find((s) => s.id === 'set-l101-1')!.currentA === 9.9)
  check('实体 rev +1', server.settings.find((s) => s.id === 'set-l101-1')!.rev === 2)
}

// 3. 同值跳过（幂等）
{
  const server = fresh()
  const pkg = makePackage(server, [{ id: 'set-l101-1', field: 'currentA', value: 8.4 }])
  const progress = applyBatch(server, pkg)
  check('服务器已是同值时跳过', progress.skipped === 1 && progress.applied === 0)
}

// 4. 两端改同一字段不同值 → 保留两版
{
  const server = fresh()
  server.settings.find((s) => s.id === 'set-l101-1')!.currentA = 7.7 // 调度端改
  const pkg = makePackage(server, [
    { id: 'set-l101-1', field: 'currentA', value: 9.9, base: 8.4 },
  ])
  const progress = applyBatch(server, pkg)
  check('产生 1 个冲突', progress.conflicts.length === 1)
  check('冲突字段保留调度端值等待复核', server.settings.find((s) => s.id === 'set-l101-1')!.currentA === 7.7)
  const c = progress.conflicts[0]
  check('保留现场版', c.localValue === 9.9)
  check('保留调度端版', c.serverValue === 7.7)
  check('保留共同基线', c.baseValue === 8.4)
  check('冲突待复核', c.status === 'pending')
}

// 5. 写入失败后从游标恢复
{
  const server = fresh()
  const pkg = makePackage(server, [
    { id: 'set-l101-1', field: 'currentA', value: 9.9 },
    { id: 'set-l201-1', field: 'currentA', value: 6.6 },
  ])
  const first = applyBatch(server, pkg, { failBefore: 1 })
  check('第一批失败：处理游标 1', first.failureAt === 1 && pkg.processed === 1)
  check('第一批之前的变更已落库', server.settings.find((s) => s.id === 'set-l101-1')!.currentA === 9.9)
  // 模拟重启：从存储重建 server/pkg 后续传
  const restoredServer: AppState = JSON.parse(JSON.stringify(server))
  const restoredPkg: OfflinePackage = JSON.parse(JSON.stringify(pkg))
  const second = applyBatch(restoredServer, restoredPkg)
  check('续传只处理剩余 1 项', second.applied === 1 && second.skipped === 0)
  check('游标到底', restoredPkg.processed === 2)
  check('第二笔已落库', restoredServer.settings.find((s) => s.id === 'set-l201-1')!.currentA === 6.6)
}

// 6. 级联重算：定值变化 → 问题/场景/基线失效
{
  const state = fresh()
  // 构造一个会签中的基线快照与当前一致
  const baseline = state.baselines[0]
  baseline.status = 'reviewing'
  baseline.snapshot = JSON.parse(JSON.stringify(state.settings))
  const beforeIssues = state.issues.length
  const setting = state.settings.find((s) => s.id === 'set-l101-1')!
  setting.timeS = 1.5 // 制造时限/配合变化
  const report = recomputeAfterSettingChange(state, [setting.id])
  check('校核问题已重算', state.issues.length >= 1 && report.issues === state.issues.length)
  const scenario = state.scenarios.find((s) => s.steps.some((st) => st.relayId === 'relay-l101'))
  check('引用定值的场景失效', scenario ? scenario.status === 'invalid' : true)
  check('会签中基线漂移失效', state.baselines[0].status === 'invalid' && state.baselines[0].drifted === true)
}

// 7. 已锁定基线漂移：保留快照但标记 drifted，不改为 invalid
{
  const state = fresh()
  state.baselines[0].status = 'locked'
  state.baselines[0].snapshot = JSON.parse(JSON.stringify(state.settings))
  state.baselines[0].drifted = false
  const setting = state.settings.find((s) => s.id === 'set-l101-1')!
  setting.currentA = 12
  recomputeAfterSettingChange(state, [setting.id])
  check('锁定基线仍为 locked', state.baselines[0].status === 'locked')
  check('锁定基线标记漂移', state.baselines[0].drifted === true)
}

console.log(`\n${passed} 项断言通过`)
