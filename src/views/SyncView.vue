<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { useSyncStore } from '@/stores/sync'
import { fieldLabels, REV_FIELDS } from '@/services/revision'
import type { ProtectionSetting } from '@/types/domain'

const store = useAppStore()
const sync = useSyncStore()
const { data } = storeToRefs(store)

const settingOptions = computed(() =>
  data.value.settings.map((setting) => {
    const relay = data.value.devices.find((item) => item.id === setting.relayId)?.name ?? setting.relayId
    return {
      label: `${relay} ${setting.stage} 段（${setting.id}）`,
      value: setting.id,
    }
  }),
)

const dispatchSettingId = ref('')
const dispatchField = ref<(typeof REV_FIELDS)[number]>('currentA')
const dispatchValue = ref<number>(0)
const localSettingId = ref('')
const localField = ref<(typeof REV_FIELDS)[number]>('currentA')
const localValue = ref<number>(0)
const mergeProgress = ref('')
const lastReceipt = computed(() =>
  sync.pkg ? sync.receipts[sync.pkg.id] : undefined,
)

const migration = computed(() => data.value.legacyMigration)

function formatValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '投入/是' : '退出/否'
  return String(value)
}

function fillDispatchValue() {
  const target = data.value.settings.find((item) => item.id === dispatchSettingId.value)
  if (target) dispatchValue.value = Number(target[dispatchField.value]) || 0
}

function fillLocalValue() {
  const target = data.value.settings.find((item) => item.id === localSettingId.value)
  if (target) localValue.value = Number(target[localField.value]) || 0
}

/** 模拟调度端（主站）在现场断网期间改了同一字段 */
async function dispatchEdit() {
  if (!dispatchSettingId.value) {
    ElMessage.warning('请选择调度端要修改的定值段')
    return
  }
  try {
    const result = await sync.simulateDispatchEdit({
      settingId: dispatchSettingId.value,
      field: dispatchField.value,
      value: dispatchValue.value,
    })
    ElMessage.success(`调度端改动已落库（权威版本 headRev=${result.state.headRev}）`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '调度端改动失败')
  }
}

function goOffline() {
  sync.goOffline(data.value)
  ElMessage.success('已切断调度链路：现在修改定值只写现场离线包')
}

function goOnline() {
  sync.goOnline()
  ElMessage.success('链路恢复：可回网提交离线包')
}

/** 现场断网期间直接改一笔定值（复用 store 的离线记录与本地重算） */
async function localEdit() {
  if (!localSettingId.value) {
    ElMessage.warning('请选择现场要修改的定值段')
    return
  }
  const target = data.value.settings.find((item) => item.id === localSettingId.value)
  if (!target) return
  const next: ProtectionSetting = { ...target, [localField.value]: localValue.value }
  const result = await store.saveSetting(next)
  if ('offline' in result && result.offline) {
    ElMessage.success(`已写入离线包：${fieldLabels[localField.value]} → ${localValue.value}`)
  }
}

async function submitFirst() {
  await doSubmit(undefined, '离线包已提交')
}

/** 两人同时提交同一份包：模拟第一份尚在处理时第二份到达 */
async function submitDuplicate() {
  if (!sync.pkg) return
  mergeProgress.value = '模拟并发：两份相同包同时到达合并接口…'
  const [, second] = await Promise.allSettled([
    sync.submitPackage(undefined),
    sync.submitPackage(undefined),
  ])
  if (second.status === 'rejected') {
    ElMessage.error(extractError(second.reason))
  }
  mergeProgress.value = '首次提交放行，重复提交已被幂等拒绝。'
}

/** 模拟写入失败：第一批落库后中断，已完成批次保留现场 */
async function submitWithFailure() {
  const changes = sync.pkg?.changes.length ?? 0
  if (changes < 2) {
    ElMessage.warning('请先在断网状态下制造至少 2 笔变更，才能演示批次中断恢复')
    return
  }
  await doSubmit(1, undefined)
}

async function doSubmit(failBefore: number | undefined, successMessage?: string) {
  try {
    const result = await sync.submitPackage(failBefore)
    if (result.failed) {
      ElMessage.warning(result.message ?? '部分批次写入失败，可恢复续传')
    } else if (result.receipt.report?.conflicts) {
      ElMessage.warning(`合并完成，${result.receipt.report.conflicts} 个字段保留两版待复核`)
    } else {
      ElMessage.success(successMessage ?? '离线包已合并')
    }
    alignAfterMerge()
  } catch (error) {
    ElMessage.error(extractError(error))
  }
}

/** 写入失败后继续：从已完成批次之后恢复 */
async function resume() {
  try {
    const result = await sync.resumePackage()
    ElMessage.success(`续传完成：应用 ${result.receipt.report?.applied ?? 0} 项`)
    alignAfterMerge()
  } catch (error) {
    ElMessage.error(extractError(error))
  }
}

/** 合并闭环后，从调度端权威版本整体对齐本地（含级联重算结果） */
async function alignAfterMerge() {
  const state = await sync.pull()
  store.applyServerState(state)
}

async function pullNow() {
  const state = await sync.pull()
  store.applyServerState(state)
  ElMessage.success('已拉取调度端权威版本并对齐本地工作台')
}

async function resolveConflict(id: string, resolution: 'local' | 'server') {
  try {
    const word = resolution === 'local' ? '采用现场版' : '采用调度端版'
    await ElMessageBox.confirm(`确认${word}并写入？写入后校核问题、场景与基线立即重算。`, '冲突复核裁定', {
      confirmButtonText: word,
      cancelButtonText: '再想想',
      type: 'warning',
    })
    const result = await sync.resolveOne(id, resolution)
    store.applyServerState(result.state)
    ElMessage.success('裁定已落库，相关校核已重算')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(extractError(error))
  }
}

async function closePackage() {
  await ElMessageBox.confirm('闭环后清除本地离线包（审计与回执保留在调度端）。', '完成并关闭', {
    confirmButtonText: '确认关闭',
    cancelButtonText: '取消',
    type: 'info',
  })
  sync.closePackage()
  ElMessage.success('离线包已关闭')
}

async function discardPackage() {
  await ElMessageBox.confirm('丢弃当前离线包将清除全部现场未提交修改记录。', '丢弃离线包', {
    confirmButtonText: '确认丢弃',
    cancelButtonText: '取消',
    type: 'error',
  })
  sync.discardPackage()
  ElMessage.success('离线包已丢弃')
}

function extractError(error: unknown): string {
  const anyError = error as { response?: { data?: { message?: string } }; message?: string }
  return anyError?.response?.data?.message ?? anyError?.message ?? '操作失败'
}

const conflictCount = computed(() => sync.pkg?.conflicts.length ?? 0)
</script>

<template>
  <div>
    <PageHeader
      title="断网修改与回网合并"
      description="现场离线包在回网后按字段三方合并；两端改过同一字段保留两版待复核；同包并发只放行一份；批次失败可断点续传。"
    >
      <template #actions>
        <el-button :disabled="sync.online" @click="goOnline">恢复调度链路</el-button>
        <el-button v-if="sync.online" type="danger" plain @click="goOffline">模拟现场断网</el-button>
        <el-button @click="pullNow">拉取调度端版本</el-button>
      </template>
    </PageHeader>

    <!-- 链路与有效修订 -->
    <section class="panel">
      <div class="panel-title">
        <h3>链路状态与修订基线</h3>
        <el-tag :type="sync.online ? 'success' : 'danger'" effect="dark">
          {{ sync.online ? '在线 · 调度联通' : '断网 · 现场离线' }}
        </el-tag>
      </div>
      <el-descriptions :column="4" border>
        <el-descriptions-item label="调度端 headRev">#{{ sync.serverHeadRev }}</el-descriptions-item>
        <el-descriptions-item label="本地 headRev">#{{ data.headRev ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="离线包状态">
          <el-tag v-if="sync.pkg" effect="plain">
            {{ { draft: '编辑中', submitting: '提交中', merged: '已合并', partial: '批次中断', conflict: '有冲突', rejected: '已拒绝' }[sync.pkg.status] }}
          </el-tag>
          <span v-else class="muted">无</span>
        </el-descriptions-item>
        <el-descriptions-item label="离线包编号">
          <span class="mono">{{ sync.pkg?.id ?? '—' }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="migration"
        class="migration-alert"
        :title="`旧档案修订号回填（${new Date(migration.at).toLocaleString('zh-CN')}）`"
        type="success"
        :closable="false"
        show-icon
      >
        <div>
          {{ migration.note }}：设备 {{ migration.backfilled.devices }}、定值
          {{ migration.backfilled.settings }}、场景 {{ migration.backfilled.scenarios }}、基线
          {{ migration.backfilled.baselines }} 全部回填 rev=1，headRev 推进至 #{{ migration.headRev }}。
        </div>
      </el-alert>
    </section>

    <div class="two-column">
      <!-- 调度端改动模拟 -->
      <section class="panel">
        <div class="panel-title"><h3>① 调度端改动（制造撞车）</h3></div>
        <p class="muted">在线模拟主站侧修改某定值，断网前/期间均可操作，修订号在权威版本上 +1。</p>
        <el-select v-model="dispatchSettingId" filterable placeholder="选择定值段" style="width: 100%" @change="fillDispatchValue">
          <el-option v-for="item in settingOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <div class="field-row">
          <el-select v-model="dispatchField" style="width: 150px" @change="fillDispatchValue">
            <el-option v-for="field in REV_FIELDS" :key="field" :label="fieldLabels[field]" :value="field" />
          </el-select>
          <el-input-number v-model="dispatchValue" :step="0.1" />
        </div>
        <el-button type="primary" :loading="sync.busy" @click="dispatchEdit">调度端写入修改</el-button>
      </section>

      <!-- 现场离线修改 -->
      <section class="panel">
        <div class="panel-title">
          <h3>② 现场断网修改</h3>
          <el-tag v-if="!sync.online" type="danger" effect="plain">离线包记录中</el-tag>
        </div>
        <p class="muted">断网后改定值不访问调度端，逐字段累计到离线包，并在本地先重算校核。</p>
        <el-select
          v-model="localSettingId"
          filterable
          placeholder="选择定值段"
          style="width: 100%"
          :disabled="sync.online"
          @change="fillLocalValue"
        >
          <el-option v-for="item in settingOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <div class="field-row">
          <el-select v-model="localField" style="width: 150px" :disabled="sync.online" @change="fillLocalValue">
            <el-option v-for="field in REV_FIELDS" :key="field" :label="fieldLabels[field]" :value="field" />
          </el-select>
          <el-input-number v-model="localValue" :step="0.1" :disabled="sync.online" />
        </div>
        <el-button type="primary" :disabled="sync.online" @click="localEdit">写入离线包</el-button>
        <el-button v-if="sync.online" disabled>需先模拟现场断网</el-button>
      </section>
    </div>

    <!-- 离线包内容与提交 -->
    <section class="panel">
      <div class="panel-title">
        <h3>③ 离线包内容与回网提交</h3>
        <el-space>
          <el-tag effect="plain">{{ sync.offlineChanges.length }} 笔字段变更</el-tag>
          <el-tag v-if="sync.pkg && sync.pkg.status === 'partial'" type="warning" effect="dark">
            已完成 {{ sync.pkg.processed }}/{{ sync.pkg.changes.length }} 批
          </el-tag>
        </el-space>
      </div>

      <el-table :data="sync.offlineChanges" max-height="240">
        <el-table-column prop="label" label="定值" min-width="200" />
        <el-table-column label="字段" width="110">
          <template #default="{ row }">{{ fieldLabels[row.field] ?? row.field }}</template>
        </el-table-column>
        <el-table-column label="断网基线值" width="120">
          <template #default="{ row }">
            <span class="diff-before">{{ formatValue(row.baseValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="现场新值" width="120">
          <template #default="{ row }">
            <span class="diff-after">{{ formatValue(row.newValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="baseRev" label="基于修订号" width="100" />
        <el-table-column label="时间" min-width="160">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
      </el-table>

      <div class="submit-bar">
        <el-button
          type="primary"
          :loading="sync.busy"
          :disabled="!sync.online || !sync.offlineChanges.length || (sync.pkg?.status === 'merged' && !conflictCount)"
          @click="submitFirst"
        >
          回网提交并合并
        </el-button>
        <el-button
          :disabled="!sync.online || !sync.offlineChanges.length"
          @click="submitDuplicate"
        >
          模拟两人同时提交（只放行一份）
        </el-button>
        <el-button
          type="warning"
          plain
          :disabled="!sync.online || !sync.offlineChanges.length"
          @click="submitWithFailure"
        >
          模拟写入失败（第 2 批中断）
        </el-button>
        <el-button
          type="success"
          :loading="sync.busy"
          :disabled="!(sync.pkg?.status === 'partial')"
          @click="resume"
        >
          继续恢复已完成批次之后的写入
        </el-button>
        <el-button
          v-if="sync.pkg && ['merged', 'conflict'].includes(sync.pkg.status) && !sync.pendingConflicts.length"
          @click="closePackage"
        >
          闭环并关闭离线包
        </el-button>
        <el-button v-if="sync.pkg" type="danger" text @click="discardPackage">丢弃离线包</el-button>
        <span v-if="mergeProgress" class="muted">{{ mergeProgress }}</span>
      </div>

      <el-alert
        v-if="lastReceipt"
        class="receipt-alert"
        :title="`服务端回执：${lastReceipt.status === 'merged' ? '已完整接收' : lastReceipt.status === 'conflict' ? '已接收（待冲突复核）' : '部分接收（可恢复）'} · 游标 ${lastReceipt.processed}/${lastReceipt.total}`"
        :type="lastReceipt.status === 'merged' ? 'success' : lastReceipt.status === 'conflict' ? 'warning' : 'error'"
        :closable="false"
        show-icon
      />
    </section>

    <!-- 冲突两版复核 -->
    <section class="panel">
      <div class="panel-title">
        <h3>④ 撞车字段：保留两版待复核</h3>
        <el-tag :type="sync.pendingConflicts.length ? 'danger' : 'success'" effect="dark">
          待复核 {{ sync.pendingConflicts.length }} · 已裁定 {{ sync.resolvedConflicts.length }}
        </el-tag>
      </div>
      <el-table :data="sync.pkg?.conflicts ?? []">
        <el-table-column prop="label" label="定值 / 字段" min-width="200">
          <template #default="{ row }">
            <strong>{{ row.label }}</strong>
            <div class="muted">{{ fieldLabels[row.field] ?? row.field }}</div>
          </template>
        </el-table-column>
        <el-table-column label="共同基线（断网前）" width="150">
          <template #default="{ row }"><span class="muted">{{ formatValue(row.baseValue) }}</span></template>
        </el-table-column>
        <el-table-column label="现场离线版" width="150">
          <template #default="{ row }">
            <span class="diff-after">{{ formatValue(row.localValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="调度端版" width="150">
          <template #default="{ row }">
            <span class="diff-before">{{ formatValue(row.serverValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 操作" min-width="240">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button size="small" type="primary" @click="resolveConflict(row.id, 'local')">
                采用现场版
              </el-button>
              <el-button size="small" type="warning" @click="resolveConflict(row.id, 'server')">
                采用调度端版
              </el-button>
            </template>
            <el-tag v-else type="success" effect="plain">
              已采用{{ row.resolution === 'local' ? '现场版' : '调度端版' }}
              <span class="muted">（{{ row.resolvedBy }}）</span>
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-if="!conflictCount"
        description="还没有撞车字段：先调度端改一笔，再断网把同一字段改成不同值，然后回网提交"
      />
    </section>

    <!-- 合并后的级联效果 -->
    <section v-if="lastReceipt?.report?.cascade" class="panel">
      <div class="panel-title"><h3>⑤ 合并后的级联重算结果</h3></div>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="校核问题总数">
          {{ lastReceipt.report.cascade.issues }}
        </el-descriptions-item>
        <el-descriptions-item label="失效重算场景">
          {{ lastReceipt.report.cascade.invalidScenarioIds.length }} 个
        </el-descriptions-item>
        <el-descriptions-item label="漂移/失效基线">
          {{ lastReceipt.report.cascade.driftedBaselineIds.length }} 个
        </el-descriptions-item>
      </el-descriptions>
      <p class="muted">
        提示：失效场景在“故障场景”页回到会签重走；漂移基线在“审批与基线”页需按当前定值重新上会签，执行页会拒绝执行漂移版本。
      </p>
    </section>
  </div>
</template>

<style scoped>
.field-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 12px 0;
}

.submit-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}

.receipt-alert,
.migration-alert {
  margin-top: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
