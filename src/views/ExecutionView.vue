<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { checksum, fieldLabels, REV_FIELDS } from '@/services/revision'

const store = useAppStore()
const { effectiveVersion, data } = storeToRefs(store)
const executing = ref(false)
const executionResult = ref<string>('')

const currentChecksum = computed(() => checksum(data.value.settings))
const verification = computed(() => store.verifyExecution())

const driftSettings = computed(() => {
  const baseline = store.activeBaseline
  if (!baseline) return []
  const baselineById = new Map(baseline.snapshot.map((item) => [item.id, item]))
  const rows: { id: string; name: string; field: string; before: unknown; after: unknown }[] = []
  data.value.settings.forEach((setting) => {
    const relayName =
      data.value.devices.find((item) => item.id === setting.relayId)?.name ?? setting.relayId
    const rowName = `${relayName} ${setting.stage} 段`
    const previous = baselineById.get(setting.id)
    if (!previous) {
      rows.push({ id: setting.id, name: rowName, field: '整条', before: '基线不存在', after: '当前新增' })
      return
    }
    REV_FIELDS.forEach((field) => {
      if (previous[field] !== setting[field]) {
        rows.push({
          id: setting.id,
          name: rowName,
          field: fieldLabels[field],
          before: previous[field],
          after: setting[field],
        })
      }
    })
  })
  return rows
})

async function execute() {
  try {
    await ElMessageBox.confirm(
      `将按有效版本 ${effectiveVersion.value?.version} 下装 ${effectiveVersion.value?.snapshotCount} 条定值，执行前会再次核对校验码。`,
      '执行定值',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  executing.value = true
  try {
    const result = await store.recordExecution()
    if (!result.ok) {
      ElMessage.error(result.reason)
      return
    }
    executionResult.value = `已于 ${new Date().toLocaleString('zh-CN')} 按 ${result.version!.version} 执行，校验码 ${result.currentChecksum} 一致。`
    ElMessage.success('定值已按有效版本执行，执行动作已写入审计')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '执行失败')
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="定值执行"
      description="执行页与审批页共用同一有效版本；校验码不一致或版本漂移时禁止下装。"
    >
      <template #actions>
        <el-button
          type="primary"
          :loading="executing"
          :disabled="!verification.ok"
          @click="execute"
        >
          按有效版本执行定值
        </el-button>
      </template>
    </PageHeader>

    <section class="panel">
      <div class="panel-title">
        <h3>有效版本核对</h3>
        <el-tag v-if="effectiveVersion" :type="effectiveVersion.drifted ? 'danger' : 'success'" effect="dark">
          {{ effectiveVersion.drifted ? '版本已漂移' : '版本可执行' }}
        </el-tag>
        <el-tag v-else type="info" effect="plain">尚无锁定版本</el-tag>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="审批页/执行页共用版本">
          <strong>{{ effectiveVersion?.version ?? '未选择' }}</strong>
        </el-descriptions-item>
        <el-descriptions-item label="版本锁定时间">
          {{ effectiveVersion?.lockedAt ? new Date(effectiveVersion.lockedAt).toLocaleString('zh-CN') : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="版本校验码（锁定时）">
          <span class="mono">{{ effectiveVersion?.checksum ?? '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="当前定值校验码">
          <span class="mono" :class="{ 'checksum-mismatch': !verification.ok }">{{ currentChecksum }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="快照定值条数">
          {{ effectiveVersion?.snapshotCount ?? 0 }} / 当前 {{ data.settings.length }}
        </el-descriptions-item>
        <el-descriptions-item label="核对结论">
          <el-tag :type="verification.ok ? 'success' : 'danger'" effect="plain">
            {{ verification.ok ? '一致，允许执行' : verification.reason }}
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="!verification.ok"
        :title="verification.reason"
        type="error"
        :closable="false"
        show-icon
        style="margin-top: 12px"
      />
      <el-alert
        v-else
        title="审批页会签锁定的版本与执行页待下装内容同源，杜绝“批一版、执行另一版”。"
        type="success"
        :closable="false"
        show-icon
        style="margin-top: 12px"
      />
    </section>

    <section v-if="driftSettings.length" class="panel">
      <div class="panel-title">
        <h3>相对有效版本的漂移字段</h3>
        <el-tag type="warning" effect="plain">{{ driftSettings.length }} 项</el-tag>
      </div>
      <el-table :data="driftSettings" max-height="320">
        <el-table-column prop="name" label="定值" min-width="180" />
        <el-table-column prop="field" label="字段" width="120" />
        <el-table-column label="版本值" width="140">
          <template #default="{ row }"><span class="diff-before">{{ row.before }}</span></template>
        </el-table-column>
        <el-table-column label="当前值" min-width="140">
          <template #default="{ row }"><span class="diff-after">{{ row.after }}</span></template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="executionResult" class="panel">
      <el-result icon="success" :title="executionResult" sub-title="执行记录可在“审计与导出”页查询" />
    </section>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.checksum-mismatch {
  color: #c84c4c;
}
</style>
