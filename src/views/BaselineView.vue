<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { diffSettings } from '@/services/validation'

const store = useAppStore()
const { data, settings, effectiveVersion, currentChecksum } = storeToRefs(store)
const selectedId = ref(data.value.activeBaselineId ?? data.value.baselines[0]?.id ?? '')
const createDialog = ref(false)
const baselineNote = ref('')
const comment = ref('')

const selected = computed(() => data.value.baselines.find((item) => item.id === selectedId.value))
const diffs = computed(() => {
  if (!selected.value) return []
  return diffSettings(settings.value, selected.value.snapshot)
})

const isStale = (baseline: (typeof data.value.baselines)[number]) =>
  baseline.status !== 'locked' && baseline.checksum !== currentChecksum.value
const baselineComments = computed(() =>
  data.value.comments.filter(
    (item) => item.targetType === 'baseline' && item.targetId === selectedId.value,
  ),
)

watch(
  () => data.value.baselines,
  (list) => {
    if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  },
)

const fieldLabels: Record<string, string> = {
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}

async function createBaseline() {
  if (!baselineNote.value.trim()) {
    ElMessage.warning('请填写本次基线说明')
    return
  }
  const created = await store.createBaseline(baselineNote.value.trim())
  selectedId.value = created.id
  baselineNote.value = ''
  createDialog.value = false
  ElMessage.success('基线已提交会签')
}

async function lockBaseline() {
  if (!selected.value) return
  try {
    await store.approveBaseline(selected.value.id)
    ElMessage.success('基线已批准并锁定为唯一有效版本')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '基线锁定失败')
  }
}

async function rebuildSelected() {
  if (!selected.value) return
  await store.rebuildBaseline(selected.value.id)
  ElMessage.success('快照已按当前定值重建，请重新会签')
}

async function submitComment() {
  if (!selected.value || !comment.value.trim()) return
  await store.addComment({
    targetType: 'baseline',
    targetId: selected.value.id,
    author: '当前用户',
    content: comment.value.trim(),
    status: 'open',
  })
  comment.value = ''
  ElMessage.success('会签意见已记录')
}
</script>

<template>
  <div>
    <PageHeader
      title="会签与基线"
      description="冻结已批准的定值快照；高风险问题未闭环时不允许锁定基线。"
    >
      <template #actions>
        <el-button @click="createDialog = true">创建基线上会签</el-button>
        <el-button
          type="primary"
          :disabled="!selected || selected.status === 'locked' || isStale(selected)"
          :loading="store.saving"
          @click="lockBaseline"
        >
          批准并锁定为有效版本
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="effectiveVersion"
      :title="`当前唯一有效版本：${effectiveVersion.version}（校验码 ${effectiveVersion.checksum}），审批页与执行页共同读取，锁定时间 ${effectiveVersion.lockedAt ? new Date(effectiveVersion.lockedAt).toLocaleString('zh-CN') : '—'}。`"
      :type="effectiveVersion.matchesCurrent ? 'success' : 'warning'"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
    />
    <el-alert
      v-else
      title="尚无锁定的有效版本，执行页将禁止下发。请在高风险问题闭环后批准并锁定基线。"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
    />

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>版本清单</h3>
          <span class="muted">锁定后作为后续差异比较与执行下发的同一有效版本</span>
        </div>
        <el-table :data="data.baselines" highlight-current-row @current-change="selectedId = $event?.id ?? selectedId">
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column prop="note" label="说明" min-width="200" />
          <el-table-column prop="createdBy" label="创建人" width="95" />
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'locked' ? 'success' : row.status === 'reviewing' ? 'warning' : 'info'"
                effect="plain"
              >
                {{ row.status === 'locked' ? '已锁定有效' : row.status === 'reviewing' ? '会签中' : '草稿' }}
              </el-tag>
              <el-tag
                v-if="isStale(row)"
                type="danger"
                effect="plain"
                size="small"
                style="margin-left: 4px"
              >
                快照失效
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="checksum" label="校验码" width="115" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>{{ selected?.version ?? '未选择版本' }}</h3>
          <div v-if="selected" style="display: flex; gap: 8px">
            <el-button
              v-if="selected.status !== 'locked' && isStale(selected)"
              size="small"
              type="warning"
              @click="rebuildSelected"
            >
              按当前定值重建快照
            </el-button>
            <el-tag v-if="selected" :type="selected.status === 'locked' ? 'success' : 'warning'" effect="plain">
              {{ selected.status === 'locked' ? '有效版本已冻结' : '会签进行中' }}
            </el-tag>
          </div>
        </div>
        <template v-if="selected">
          <el-alert
            v-if="isStale(selected)"
            title="定值已变化：该会签基线快照失效，请按当前定值重建快照后重新会签，锁定会被拒绝。"
            type="error"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
          />
          <el-descriptions :column="1" border>
            <el-descriptions-item label="基线说明">{{ selected.note }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">
              {{ new Date(selected.createdAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="锁定时间">
              {{ selected.lockedAt ? new Date(selected.lockedAt).toLocaleString('zh-CN') : '尚未锁定' }}
            </el-descriptions-item>
            <el-descriptions-item label="快照定值">{{ selected.snapshot.length }} 条</el-descriptions-item>
            <el-descriptions-item v-if="selected.rebuiltAt" label="快照重建时间">
              {{ new Date(selected.rebuiltAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="校验码">
              <span class="mono">{{ selected.checksum }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <div class="panel-title" style="margin-top: 18px">
            <h3>与当前定值差异</h3>
            <el-tag :type="diffs.length ? 'warning' : 'success'" effect="plain">
              {{ diffs.length }} 项变化
            </el-tag>
          </div>
          <el-table :data="diffs" max-height="260">
            <el-table-column label="保护装置" width="115">
              <template #default="{ row }">
                {{ data.devices.find((device) => device.id === row.relayName)?.name ?? row.relayName }}
              </template>
            </el-table-column>
            <el-table-column label="字段" width="110">
              <template #default="{ row }">{{ fieldLabels[row.field] ?? row.field }}</template>
            </el-table-column>
            <el-table-column label="基线值" width="120">
              <template #default="{ row }"><span class="diff-before">{{ row.before }}</span></template>
            </el-table-column>
            <el-table-column label="当前值" min-width="130">
              <template #default="{ row }"><span class="diff-after">{{ row.after }}</span></template>
            </el-table-column>
          </el-table>
        </template>
      </section>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>会签意见</h3></div>
        <div v-for="item in baselineComments" :key="item.id" class="comment-item">
          <div class="comment-meta">
            <strong>{{ item.author }}</strong>
            <span>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <div>{{ item.content }}</div>
        </div>
        <el-empty v-if="!baselineComments.length" description="该版本暂无会签意见" :image-size="70" />
        <el-input
          v-model="comment"
          type="textarea"
          :rows="3"
          placeholder="填写对定值基线、差异或锁定条件的意见"
        />
        <el-button type="primary" style="margin-top: 10px" :disabled="!comment.trim()" @click="submitComment">
          记录意见
        </el-button>
      </section>

      <section class="panel">
        <div class="panel-title"><h3>锁定条件</h3></div>
        <div class="lock-checklist">
          <el-checkbox :model-value="true" disabled>批量校验已执行并留痕</el-checkbox>
          <el-checkbox :model-value="true" disabled>至少一个故障场景已完成验证</el-checkbox>
          <el-checkbox
            :model-value="!data.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')"
            disabled
          >
            高风险问题全部关闭
          </el-checkbox>
          <el-checkbox :model-value="!!selected && !isStale(selected)" disabled>
            快照与当前定值一致（无失效）
          </el-checkbox>
        </div>
        <el-alert
          v-if="selected && isStale(selected)"
          title="基线快照已落后当前定值，请先重建快照并重新会签。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="data.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')"
          title="当前存在未关闭的高风险问题，批准锁定会被系统拒绝。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else
          title="锁定条件已满足，可以执行批准并锁定。"
          type="success"
          :closable="false"
          show-icon
        />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="创建基线上会签" width="520px">
      <el-form label-width="90px">
        <el-form-item label="基线说明" required>
          <el-input v-model="baselineNote" type="textarea" :rows="4" placeholder="说明变更范围、计算依据和会签要求" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!baselineNote.trim()" @click="createBaseline">
          提交会签
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
