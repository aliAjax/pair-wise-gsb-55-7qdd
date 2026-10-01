<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { settingFieldLabels } from '@/services/revision'
import type { FieldValue, ProtectionSetting, SettingField } from '@/types/domain'

const store = useAppStore()
const {
  effectiveVersion,
  activeBaseline,
  settings,
  devices,
  issues,
  currentChecksum,
  executionRecords,
} = storeToRefs(store)

const executeNote = ref('')
const executing = ref(false)

const relayName = (relayId: string) =>
  devices.value.find((device) => device.id === relayId)?.name ?? relayId

const openHighIssues = computed(() =>
  issues.value.filter((issue) => issue.level === 'high' && issue.status !== 'closed'),
)

interface DivergenceRow {
  setting: ProtectionSetting
  field: SettingField | 'id'
  before: FieldValue | string
  after: FieldValue | string
}

/** 有效版本快照与当前定值逐条比对，给执行前最后一道核对。 */
const divergence = computed<DivergenceRow[]>(() => {
  if (!activeBaseline.value) return []
  const rows: DivergenceRow[] = []
  activeBaseline.value.snapshot.forEach((snapshot) => {
    const current = settings.value.find((item) => item.id === snapshot.id)
    if (!current) {
      rows.push({ setting: snapshot, field: 'id', before: '缺失', after: '当前无该定值' })
      return
    }
    ;(Object.keys(settingFieldLabels) as SettingField[]).forEach((field) => {
      if (snapshot[field] !== current[field]) {
        rows.push({
          setting: snapshot,
          field,
          before: snapshot[field] as FieldValue,
          after: current[field] as FieldValue,
        })
      }
    })
  })
  return rows
})

const canExecute = computed(
  () =>
    !!effectiveVersion.value &&
    effectiveVersion.value.matchesCurrent &&
    openHighIssues.value.length === 0,
)

async function execute() {
  executing.value = true
  try {
    const record = await store.executeEffectiveVersion(executeNote.value.trim())
    ElMessage.success(`有效版本 ${record.version} 已按快照下发（${record.checksum}）`)
    executeNote.value = ''
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '下发失败')
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="有效版本执行下发"
      description="本页与“会签与基线”审批页读取同一个有效版本；未锁定、快照落后或存在高风险问题时禁止下发。"
    >
      <template #actions>
        <el-tag :type="effectiveVersion ? 'success' : 'danger'" effect="plain" size="large">
          {{ effectiveVersion ? `有效版本 ${effectiveVersion.version}` : '无有效版本' }}
        </el-tag>
      </template>
    </PageHeader>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>执行版本核对</h3>
          <el-tag :type="effectiveVersion?.matchesCurrent ? 'success' : 'danger'" effect="plain">
            {{ effectiveVersion?.matchesCurrent ? '快照与当前定值一致' : '快照落后当前定值' }}
          </el-tag>
        </div>
        <el-descriptions v-if="effectiveVersion" :column="1" border>
          <el-descriptions-item label="版本号">{{ effectiveVersion.version }}</el-descriptions-item>
          <el-descriptions-item label="校验码">
            <span class="mono">{{ effectiveVersion.checksum }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="锁定时间">
            {{ effectiveVersion.lockedAt ? new Date(effectiveVersion.lockedAt).toLocaleString('zh-CN') : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="快照定值数">{{ effectiveVersion.settingCount }} 条</el-descriptions-item>
          <el-descriptions-item label="版本说明">{{ effectiveVersion.note }}</el-descriptions-item>
          <el-descriptions-item label="当前定值校验码">
            <span class="mono">{{ currentChecksum }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <el-empty v-else description="尚无已锁定有效版本，请先到会签页批准并锁定基线" />

        <el-alert
          v-if="effectiveVersion && !effectiveVersion.matchesCurrent"
          title="当前定值已偏离有效版本：离线合并/在线修改后需重建快照并重新会签锁定，才能执行。"
          type="error"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
        <el-alert
          v-if="openHighIssues.length"
          :title="`存在 ${openHighIssues.length} 条未关闭高风险校核问题，下发被禁止。`"
          type="error"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
        <el-alert
          v-if="effectiveVersion && effectiveVersion.matchesCurrent && !openHighIssues.length"
          title="版本、快照与校核结论均满足下发条件。"
          type="success"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />

        <el-divider content-position="left">下发说明（写入审计链）</el-divider>
        <el-input v-model="executeNote" type="textarea" :rows="3" placeholder="例如：秋检现场按调度令 2026-10-01-03 执行" />
        <el-button
          type="primary"
          size="large"
          style="width: 100%; margin-top: 12px"
          :disabled="!canExecute"
          :loading="executing"
          @click="execute"
        >
          按有效版本快照执行下发
        </el-button>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>与有效版本差异</h3>
          <el-tag :type="divergence.length ? 'danger' : 'success'" effect="plain">
            {{ divergence.length }} 项偏离
          </el-tag>
        </div>
        <el-table :data="divergence" max-height="280">
          <el-table-column label="保护装置" width="130">
            <template #default="{ row }">{{ relayName(row.setting.relayId) }}</template>
          </el-table-column>
          <el-table-column label="段位" width="70">
            <template #default="{ row }">{{ row.setting.stage }}</template>
          </el-table-column>
          <el-table-column label="字段" width="110">
            <template #default="{ row }">{{ settingFieldLabels[row.field as keyof typeof settingFieldLabels] ?? row.field }}</template>
          </el-table-column>
          <el-table-column label="有效版本" width="120">
            <template #default="{ row }"><span class="diff-before">{{ row.before }}</span></template>
          </el-table-column>
          <el-table-column label="当前值" min-width="120">
            <template #default="{ row }"><span class="diff-after">{{ row.after }}</span></template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!divergence.length" description="当前定值与有效版本完全一致" :image-size="70" />
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>有效版本定值清单（即将下发）</h3>
        <span class="muted">数据源：已锁定基线快照，与审批页同源</span>
      </div>
      <el-table :data="activeBaseline?.snapshot ?? []" max-height="420">
        <el-table-column label="保护装置" min-width="150">
          <template #default="{ row }">{{ relayName(row.relayId) }}</template>
        </el-table-column>
        <el-table-column prop="stage" label="段位" width="70" />
        <el-table-column label="修订号" width="90">
          <template #default="{ row }">rev {{ row.revision }}</template>
        </el-table-column>
        <el-table-column prop="currentA" label="电流(A)" width="100" />
        <el-table-column prop="timeS" label="时限(s)" width="90" />
        <el-table-column prop="direction" label="方向" width="110" />
        <el-table-column prop="sensitivity" label="灵敏度" width="90" />
        <el-table-column label="重合闸" width="110">
          <template #default="{ row }">{{ row.recloseEnabled ? `${row.recloseDelayS}s` : '退出' }}</template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel">
      <div class="panel-title"><h3>下发记录（审计链）</h3></div>
      <el-timeline>
        <el-timeline-item
          v-for="record in executionRecords"
          :key="record.id"
          :timestamp="new Date(record.createdAt).toLocaleString('zh-CN')"
          placement="top"
          type="success"
        >
          <strong>{{ record.version }}</strong>
          <span class="muted"> · 校验码 {{ record.checksum }} · {{ record.operator }}</span>
          <p>{{ record.note || '按调度令执行' }}</p>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="!executionRecords.length" description="尚无下发记录" :image-size="70" />
    </section>
  </div>
</template>
