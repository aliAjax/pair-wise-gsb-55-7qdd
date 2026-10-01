<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { SyncError } from '@/api/client'
import { formatFieldValue, settingFieldLabels, SETTING_FIELDS } from '@/services/revision'
import type { FieldValue, OfflinePackage, ProtectionSetting, SettingField } from '@/types/domain'

const store = useAppStore()
const {
  networkMode,
  offlinePackages,
  mergeConflicts,
  currentChecksum,
  staleScenarios,
  staleBaselines,
  pendingConflicts,
  interruptedPackages,
  settings,
  devices,
} = storeToRefs(store)

const createDialog = ref(false)
const dispatchDialog = ref(false)
const selectedPackageId = ref('')
const submitting = ref(false)

const packageForm = reactive({
  site: '北郊 110kV 间隔',
  note: '现场检修后按实测短路电流调整定值',
  operator: '现场工程师',
  items: [] as { settingId: string; field: SettingField; value: number | string | boolean }[],
})

const dispatchForm = reactive({
  settingId: settings.value.find((item) => item.id === 'set-l101-1')?.id ?? '',
  field: 'currentA' as SettingField,
  currentA: 8.9,
  timeS: 0.05,
  sensitivity: 1.82,
  recloseDelayS: 1.2,
  startCondition: '',
  direction: 'forward' as ProtectionSetting['direction'],
  operator: '调度值班员',
})

const relayName = (settingId: string) => {
  const setting = settings.value.find((item) => item.id === settingId)
  if (!setting) return settingId
  const relay = devices.value.find((device) => device.id === setting.relayId)
  return `${relay?.name ?? setting.relayId} · ${setting.stage} 段`
}

const settingOptions = computed(() =>
  settings.value.map((setting) => ({
    id: setting.id,
    label: `${relayName(setting.id)}（rev ${setting.revision}）`,
  })),
)

const selectedPackage = computed<OfflinePackage | undefined>(() =>
  offlinePackages.value.find((pkg) => pkg.id === selectedPackageId.value) ??
  offlinePackages.value[0],
)

function itemStatusLabel(status: string) {
  return (
    { pending: '待写入', applied: '已合并', conflict: '冲突待复核', skipped: '自动一致' } as Record<
      string,
      string
    >
  )[status] ?? status
}

function itemStatusType(status: string) {
  return (
    { pending: 'info', applied: 'success', conflict: 'danger', skipped: 'warning' } as Record<
      string,
      'info' | 'success' | 'danger' | 'warning'
    >
  )[status] ?? 'info'
}

function packageStatusLabel(status: string) {
  return (
    { draft: '草稿', sealed: '已封存待回网', submitting: '合并中断可恢复', merged: '已合并' } as Record<
      string,
      string
    >
  )[status] ?? status
}

function packageStatusType(status: string) {
  return (
    { draft: 'info', sealed: 'warning', submitting: 'danger', merged: 'success' } as Record<
      string,
      'info' | 'warning' | 'danger' | 'success'
    >
  )[status] ?? 'info'
}

function addItemRow() {
  packageForm.items.push({
    settingId: settingOptions.value[0]?.id ?? '',
    field: 'currentA',
    value: 8,
  })
}

function openCreateDialog() {
  packageForm.items = []
  addItemRow()
  createDialog.value = true
}

function onItemFieldChange(index: number) {
  const item = packageForm.items[index]
  const setting = settings.value.find((candidate) => candidate.id === item.settingId)
  const current = setting?.[item.field]
  item.value = (current ?? '') as FieldValue as number | string | boolean
}

function onItemSettingChange(index: number) {
  onItemFieldChange(index)
}

function removeItemRow(index: number) {
  packageForm.items.splice(index, 1)
}

async function createPackage() {
  if (!packageForm.items.length) {
    ElMessage.warning('请至少添加一条离线修改')
    return
  }
  const pkg = store.createOfflinePackage({
    site: packageForm.site,
    note: packageForm.note,
    operator: packageForm.operator,
  })
  packageForm.items.forEach((item) =>
    store.addOfflineItem(pkg.id, {
      settingId: item.settingId,
      field: item.field,
      offlineValue: item.value as FieldValue,
    }),
  )
  await store.sealOfflinePackage(pkg.id)
  selectedPackageId.value = pkg.id
  createDialog.value = false
  packageForm.items = []
  ElMessage.success(`离线包 ${pkg.code} 已封存，回网后可提交合并`)
}

/** 一键构造演示离线包：现场修改 101 I 段电流与 201 I 段时限。 */
async function createDemoPackage() {
  const pkg = store.createOfflinePackage({
    site: '北郊 110kV 间隔',
    note: '现场实测后调整：101 I 段电流、201 I 段时限',
    operator: '现场工程师',
  })
  store.addOfflineItem(pkg.id, { settingId: 'set-l101-1', field: 'currentA', offlineValue: 9.2 })
  store.addOfflineItem(pkg.id, { settingId: 'set-l201-1', field: 'timeS', offlineValue: 0.12 })
  await store.sealOfflinePackage(pkg.id)
  selectedPackageId.value = pkg.id
  ElMessage.success(`演示离线包 ${pkg.code} 已封存（含 2 项修改），可回网提交`)
}

async function submitPackage(pkg: OfflinePackage, failAtItem?: number) {
  if (networkMode.value !== 'online') {
    ElMessage.warning('当前处于断网模式，请先恢复联网再提交合并')
    return
  }
  submitting.value = true
  try {
    const result = await store.submitOfflinePackage(pkg.id, failAtItem)
    if (result.interrupted) {
      ElMessage.warning(`写入中断：${result.appliedCount} 项已完成落盘，可点击“继续恢复批次”续传`)
    } else {
      ElMessage.success(
        `合并完成：写入 ${result.appliedCount} 项，冲突 ${result.conflictCount} 项，自动一致 ${result.skippedCount} 项`,
      )
    }
  } catch (error) {
    if (error instanceof SyncError) ElMessage.error(error.message)
    else if (error instanceof Error) ElMessage.error(error.message)
  } finally {
    submitting.value = false
  }
}

/** 模拟两人同时提交：第二份请求必然被只放行一份的幂等锁拒绝。 */
async function simulateConcurrentSubmit(pkg: OfflinePackage) {
  if (networkMode.value !== 'online') {
    ElMessage.warning('请先恢复联网')
    return
  }
  submitting.value = true
  try {
    const first = store.submitOfflinePackage(pkg.id, undefined, 'client-工程师甲')
    const second = store.submitOfflinePackage(pkg.id, undefined, 'client-工程师乙')
    const results = await Promise.allSettled([first, second])
    const rejected = results.filter((item) => item.status === 'rejected')
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    if (fulfilled.length === 1 && rejected.length === 1) {
      const reason = rejected[0] as PromiseRejectedResult
      ElMessage.warning(
        `两人同时提交同一包：仅放行工程师甲/乙中的一份，另一份被拦截：${reason.reason instanceof Error ? reason.reason.message : '重复提交'}`,
      )
    } else if (rejected.length === 2) {
      const reason = rejected[0] as PromiseRejectedResult
      ElMessage.info(
        `两份请求均未写入：${reason.reason instanceof Error ? reason.reason.message : '重复提交'}。该包已无待处理项或已完成。`,
      )
    } else {
      ElMessage.info('并发演示结束，可在新封存的包上重试')
    }
  } finally {
    submitting.value = false
  }
}

async function resolveConflict(conflictId: string, choice: 'offline' | 'dispatch') {
  await store.resolveMergeConflict(conflictId, choice)
  ElMessage.success(choice === 'offline' ? '已采用现场离线版并触发重算' : '已采用调度端版本并触发重算')
}

async function applyDispatchChange() {
  const setting = settings.value.find((item) => item.id === dispatchForm.settingId)
  if (!setting) return
  const field = dispatchForm.field
  const valueMap: Record<SettingField, FieldValue> = {
    currentA: dispatchForm.currentA,
    timeS: dispatchForm.timeS,
    direction: dispatchForm.direction,
    sensitivity: dispatchForm.sensitivity,
    recloseEnabled: setting.recloseEnabled,
    recloseDelayS: dispatchForm.recloseDelayS,
    startCondition: dispatchForm.startCondition || setting.startCondition,
  }
  await store.applyDispatchChange({
    settingId: dispatchForm.settingId,
    field,
    value: valueMap[field],
    operator: dispatchForm.operator,
  })
  dispatchDialog.value = false
  ElMessage.success(`调度端已在线修改 ${relayName(dispatchForm.settingId)} 的 ${settingFieldLabels[field]}`)
}

/** 快速制造与演示离线包同字段的调度端改动，用于复现撞车冲突。 */
async function simulateDispatchCollision() {
  await store.applyDispatchChange({
    settingId: 'set-l101-1',
    field: 'currentA',
    value: 8.9,
    operator: '调度值班员',
  })
  ElMessage.success('调度端已把 101 I 段电流改为 8.9A，回网提交离线包将产生同字段冲突')
}

async function importLegacy() {
  await store.importLegacyBatch()
  ElMessage.success('旧台账已导入，缺失修订号已按首次导入回填为 rev 1')
}

const conflictOfItem = (pkg: OfflinePackage, itemId: string) =>
  mergeConflicts.value.find(
    (conflict) => conflict.packageId === pkg.id && conflict.itemId === itemId,
  )

const progressOf = (pkg: OfflinePackage) => {
  const done = pkg.items.filter((item) => item.status !== 'pending').length
  return { done, total: pkg.items.length }
}
</script>

<template>
  <div>
    <PageHeader
      title="断网合并与审校链"
      description="现场断网修改封存为离线包，回网后按修订号三方合并；同字段两端各改一版则保留两版待复核，并级联重算校核、场景与基线。"
    >
      <template #actions>
        <el-button
          :type="networkMode === 'offline' ? 'warning' : 'success'"
          @click="store.setNetworkMode(networkMode === 'offline' ? 'online' : 'offline')"
        >
          {{ networkMode === 'offline' ? '当前断网 · 点击恢复联网' : '当前联网 · 点击模拟断网' }}
        </el-button>
        <el-button @click="importLegacy">导入旧版台账（无修订号）</el-button>
        <el-button type="primary" @click="openCreateDialog">新建离线包</el-button>
      </template>
    </PageHeader>

    <section class="metric-grid">
      <div class="metric">
        <span>当前定值校验码</span>
        <strong class="mono" style="font-size: 18px">{{ currentChecksum }}</strong>
        <small>任何来源写入成功都会改变</small>
      </div>
      <div class="metric warning">
        <span>待复核冲突（两版保留）</span>
        <strong>{{ pendingConflicts.length }}</strong>
        <small>裁决采用现场版或调度版后触发重算</small>
      </div>
      <div class="metric danger">
        <span>可恢复的中断批次</span>
        <strong>{{ interruptedPackages.length }}</strong>
        <small>已完成项已落盘，剩余项断点续传</small>
      </div>
      <div class="metric info">
        <span>失效待重算</span>
        <strong>{{ staleScenarios.length }} 场景 / {{ staleBaselines.length }} 基线</strong>
        <small>定值一变自动按校验码判定</small>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>演示引导</h3>
        <el-tag :type="networkMode === 'offline' ? 'warning' : 'success'" effect="plain">
          {{ networkMode === 'offline' ? '断网作业中' : '在线联网中' }}
        </el-tag>
      </div>
      <el-steps :active="networkMode === 'offline' ? 1 : pendingConflicts.length ? 3 : interruptedPackages.length ? 2 : 0" align-center finish-status="success">
        <el-step title="① 断网封存" description="一键生成现场离线包" />
        <el-step title="② 调度端撞车" description="回网前调度端先改同字段" />
        <el-step title="③ 回网合并/中断恢复" description="同包只放行一份，失败可续传" />
        <el-step title="④ 冲突复核与级联重算" description="保留两版，裁决后重算" />
      </el-steps>
      <div class="timeline-actions" style="margin-top: 16px; justify-content: center; flex-wrap: wrap">
        <el-button type="primary" plain @click="createDemoPackage">一键生成演示离线包（2 项修改）</el-button>
        <el-button type="warning" plain @click="simulateDispatchCollision">模拟调度端改同字段（撞车）</el-button>
        <el-button
          type="danger"
          plain
          :disabled="!selectedPackage || selectedPackage.status !== 'sealed'"
          @click="selectedPackage && submitPackage(selectedPackage, 2)"
        >
          提交并在第 2 项处注入写入失败
        </el-button>
        <el-button
          plain
          :disabled="!selectedPackage || !['sealed', 'submitting'].includes(selectedPackage.status)"
          :loading="submitting"
          @click="selectedPackage && simulateConcurrentSubmit(selectedPackage)"
        >
          模拟两人同时提交同一包
        </el-button>
      </div>
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>离线包批次</h3>
          <span class="muted">封存后幂等键固定，重复/并发提交只放行一份</span>
        </div>
        <el-table
          :data="offlinePackages"
          highlight-current-row
          @current-change="(row: OfflinePackage | undefined) => row && (selectedPackageId = row.id)"
        >
          <el-table-column prop="code" label="包号" width="170" />
          <el-table-column prop="site" label="作业现场" min-width="150" />
          <el-table-column label="进度" width="100">
            <template #default="{ row }">
              {{ progressOf(row).done }}/{{ progressOf(row).total }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <el-tag :type="packageStatusType(row.status)" effect="plain" size="small">
                {{ packageStatusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'sealed'"
                link
                type="primary"
                :loading="submitting"
                @click.stop="submitPackage(row)"
              >
                回网提交
              </el-button>
              <el-button
                v-if="row.status === 'submitting'"
                link
                type="warning"
                :loading="submitting"
                @click.stop="submitPackage(row)"
              >
                继续恢复批次
              </el-button>
              <el-tag v-if="row.status === 'merged'" type="success" effect="plain" size="small">
                合并完成
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!offlinePackages.length" description="尚无离线包，可使用上方演示引导一键生成" />
      </section>

      <section class="panel" v-if="selectedPackage">
        <div class="panel-title">
          <div>
            <h3>{{ selectedPackage.code }}</h3>
            <span class="muted">{{ selectedPackage.site }} · {{ selectedPackage.operator }}</span>
          </div>
          <el-tag :type="packageStatusType(selectedPackage.status)" effect="plain">
            {{ packageStatusLabel(selectedPackage.status) }}
          </el-tag>
        </div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="基底校验码">
            <span class="mono">{{ selectedPackage.baseChecksum }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="幂等键">
            <span class="mono">{{ selectedPackage.idempotencyKey }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="封存时间">
            {{ selectedPackage.sealedAt ? new Date(selectedPackage.sealedAt).toLocaleString('zh-CN') : '未封存' }}
          </el-descriptions-item>
          <el-descriptions-item label="说明">{{ selectedPackage.note }}</el-descriptions-item>
          <el-descriptions-item v-if="selectedPackage.lastError" label="中断原因">
            <span class="diff-before">{{ selectedPackage.lastError }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </section>
    </div>

    <section class="panel" v-if="selectedPackage">
      <div class="panel-title">
        <h3>{{ selectedPackage.code }} 修改项明细</h3>
        <span class="muted">三方合并：共同基线 / 现场离线版 / 调度在库版</span>
      </div>
      <el-table :data="selectedPackage.items" row-key="id">
        <el-table-column label="保护定值" min-width="200">
          <template #default="{ row }">{{ relayName(row.settingId) }}</template>
        </el-table-column>
        <el-table-column label="字段" width="130">
          <template #default="{ row }">{{ settingFieldLabels[row.field as SettingField] }}</template>
        </el-table-column>
        <el-table-column label="基线值" width="110">
          <template #default="{ row }">
            <span class="diff-before">{{ formatFieldValue(row.field, row.baseValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="现场离线版" width="110">
          <template #default="{ row }">
            <strong>{{ formatFieldValue(row.field, row.offlineValue) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="调度在库版" width="110">
          <template #default="{ row }">
            <span v-if="conflictOfItem(selectedPackage, row.id)" class="diff-after">
              {{ formatFieldValue(row.field, conflictOfItem(selectedPackage, row.id)!.dispatchValue) }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="120">
          <template #default="{ row }">
            <el-tag :type="itemStatusType(row.status)" effect="plain" size="small">
              {{ itemStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="说明" min-width="240" />
      </el-table>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>冲突复核（两端改过同一字段，两版均保留）</h3>
        <el-button text type="primary" @click="dispatchDialog = true">手动模拟调度端任意改动</el-button>
      </div>
      <el-table :data="mergeConflicts" row-key="id">
        <el-table-column label="来源包" width="170">
          <template #default="{ row }">
            <span class="mono">{{ row.packageCode }}</span>
          </template>
        </el-table-column>
        <el-table-column label="保护定值" min-width="180">
          <template #default="{ row }">{{ relayName(row.settingId) }}</template>
        </el-table-column>
        <el-table-column label="字段" width="120">
          <template #default="{ row }">{{ settingFieldLabels[row.field as SettingField] }}</template>
        </el-table-column>
        <el-table-column label="共同基线" width="100">
          <template #default="{ row }">
            <span class="muted">{{ formatFieldValue(row.field, row.baseValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="现场离线版" width="110">
          <template #default="{ row }"><strong>{{ formatFieldValue(row.field, row.offlineValue) }}</strong></template>
        </el-table-column>
        <el-table-column label="调度在库版" width="110">
          <template #default="{ row }">
            <strong class="diff-after">{{ formatFieldValue(row.field, row.dispatchValue) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="裁决" width="210">
          <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-button size="small" type="primary" @click="resolveConflict(row.id, 'offline')">
              采用现场版
            </el-button>
            <el-button size="small" type="warning" @click="resolveConflict(row.id, 'dispatch')">
              采用调度版
            </el-button>
          </template>
          <el-tag v-else :type="row.status === 'resolved-offline' ? 'primary' : 'warning'" effect="plain" size="small">
            {{ row.status === 'resolved-offline' ? '已采现场版' : '已采调度版' }}
            · {{ row.resolvedBy }}
          </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!mergeConflicts.length" description="暂无冲突；先封存离线包，再让调度端修改同一字段后回网提交" />
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>失效场景（定值已变，待重新验证）</h3></div>
        <el-table :data="staleScenarios">
          <el-table-column prop="name" label="场景" min-width="200" />
          <el-table-column label="原依据校验码" width="150">
            <template #default="{ row }"><span class="mono">{{ row.basisChecksum }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" @click="store.reverifyScenario(row.id)">重新验证</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!staleScenarios.length" description="无失效场景" :image-size="70" />
      </section>

      <section class="panel">
        <div class="panel-title"><h3>失效会签基线（快照落后当前定值）</h3></div>
        <el-table :data="staleBaselines">
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column label="快照校验码" width="150">
            <template #default="{ row }"><span class="mono">{{ row.checksum }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" @click="store.rebuildBaseline(row.id)">重建快照</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!staleBaselines.length" description="无失效基线（已锁定有效版本不失效）" :image-size="70" />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="新建现场离线包（断网作业）" width="720px">
      <el-form label-width="100px">
        <el-form-item label="作业现场" required>
          <el-input v-model="packageForm.site" />
        </el-form-item>
        <el-form-item label="现场负责人">
          <el-input v-model="packageForm.operator" />
        </el-form-item>
        <el-form-item label="修改说明">
          <el-input v-model="packageForm.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-divider content-position="left">离线修改条目（基底值取封存时在库版本）</el-divider>
        <div v-for="(item, index) in packageForm.items" :key="index" class="offline-item-row">
          <el-select
            v-model="item.settingId"
            style="width: 260px"
            @change="() => onItemSettingChange(index)"
          >
            <el-option v-for="option in settingOptions" :key="option.id" :label="option.label" :value="option.id" />
          </el-select>
          <el-select
            v-model="item.field"
            style="width: 150px"
            @change="() => onItemFieldChange(index)"
          >
            <el-option v-for="field in SETTING_FIELDS" :key="field" :label="settingFieldLabels[field]" :value="field" />
          </el-select>
          <el-input-number
            v-if="typeof (settings.find((s) => s.id === item.settingId)?.[item.field]) === 'number'"
            :model-value="Number(item.value)"
            :step="item.field === 'timeS' || item.field === 'recloseDelayS' ? 0.05 : 0.1"
            @update:model-value="(v: number) => (item.value = v)"
          />
          <el-switch
            v-else-if="typeof (settings.find((s) => s.id === item.settingId)?.[item.field]) === 'boolean'"
            :model-value="Boolean(item.value)"
            @update:model-value="(v: boolean) => (item.value = v)"
          />
          <el-input
            v-else
            :model-value="String(item.value)"
            style="width: 150px"
            placeholder="离线值"
            @update:model-value="(v: string) => (item.value = v)"
          />
          <el-button type="danger" link @click="removeItemRow(index)">移除</el-button>
        </div>
        <el-button style="margin-top: 10px" @click="addItemRow">+ 添加修改条目</el-button>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="createPackage">封存离线包</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dispatchDialog" title="模拟调度端在线修改" width="520px">
      <el-form label-width="100px">
        <el-form-item label="目标定值">
          <el-select v-model="dispatchForm.settingId" style="width: 100%">
            <el-option v-for="option in settingOptions" :key="option.id" :label="option.label" :value="option.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="修改字段">
          <el-select v-model="dispatchForm.field" style="width: 100%">
            <el-option v-for="field in SETTING_FIELDS" :key="field" :label="settingFieldLabels[field]" :value="field" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="dispatchForm.field === 'currentA'" label="电流定值">
          <el-input-number v-model="dispatchForm.currentA" :step="0.1" />
        </el-form-item>
        <el-form-item v-else-if="dispatchForm.field === 'timeS'" label="动作时限">
          <el-input-number v-model="dispatchForm.timeS" :step="0.05" />
        </el-form-item>
        <el-form-item v-else-if="dispatchForm.field === 'sensitivity'" label="灵敏度">
          <el-input-number v-model="dispatchForm.sensitivity" :step="0.01" />
        </el-form-item>
        <el-form-item v-else-if="dispatchForm.field === 'recloseDelayS'" label="重合延迟">
          <el-input-number v-model="dispatchForm.recloseDelayS" :step="0.1" />
        </el-form-item>
        <el-form-item v-else-if="dispatchForm.field === 'startCondition'" label="启动条件">
          <el-input v-model="dispatchForm.startCondition" />
        </el-form-item>
        <el-form-item v-else-if="dispatchForm.field === 'direction'" label="方向">
          <el-select v-model="dispatchForm.direction" style="width: 100%">
            <el-option label="正向" value="forward" />
            <el-option label="反向" value="reverse" />
            <el-option label="无方向" value="non-directional" />
          </el-select>
        </el-form-item>
        <el-form-item v-else label="重合闸投入">
          <el-alert title="请直接在定值编辑页切换布尔型字段" type="info" :closable="false" />
        </el-form-item>
        <el-form-item label="调度操作人">
          <el-input v-model="dispatchForm.operator" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dispatchDialog = false">取消</el-button>
        <el-button type="warning" @click="applyDispatchChange">提交调度端改动</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.offline-item-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}
</style>
