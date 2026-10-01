<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import PageHeader from '@/components/PageHeader.vue'
import IssueTable from '@/components/IssueTable.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const store = useAppStore()
const {
  data,
  issues,
  devices,
  scenarios,
  effectiveVersion,
  currentChecksum,
  pendingConflicts,
  interruptedPackages,
  staleScenarios,
  staleBaselines,
  offlinePackages,
} = storeToRefs(store)

const highIssues = computed(() => issues.value.filter((issue) => issue.level === 'high'))
const runningDevices = computed(() => devices.value.filter((device) => device.status === 'running').length)

const statusType = (status: string) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'returned'
        ? 'danger'
        : 'info'

const statusText = (status: string) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
  })[status] ?? status
</script>

<template>
  <div>
    <PageHeader
      title="运行总览"
      description="聚焦保护配合异常、场景验证和当前可执行基线。全部数据保存在当前浏览器。"
    >
      <template #actions>
        <el-button @click="router.push('/coordination')">进入配合校核</el-button>
        <el-button type="primary" @click="router.push('/scenarios')">验证故障场景</el-button>
      </template>
    </PageHeader>

    <section class="metric-grid">
      <div class="metric danger">
        <span>高风险问题</span>
        <strong>{{ highIssues.length }}</strong>
        <small>需在有效版本锁定前关闭</small>
      </div>
      <div class="metric info">
        <span>运行设备</span>
        <strong>{{ runningDevices }} / {{ devices.length }}</strong>
        <small>含台账修订号 rev 跟踪</small>
      </div>
      <div class="metric warning">
        <span>断网合并待办</span>
        <strong>{{ pendingConflicts.length + interruptedPackages.length }}</strong>
        <small>{{ pendingConflicts.length }} 冲突待复核 · {{ interruptedPackages.length }} 批次待恢复</small>
      </div>
      <div class="metric" :class="{ warning: !effectiveVersion || !effectiveVersion.matchesCurrent }">
        <span>有效版本{{ effectiveVersion ? '' : '（未发布）' }}</span>
        <strong style="font-size: 22px">{{ effectiveVersion?.version ?? '—' }}</strong>
        <small class="mono">{{ effectiveVersion?.checksum ?? '请先锁定基线' }}</small>
      </div>
    </section>

    <el-alert
      v-if="effectiveVersion && !effectiveVersion.matchesCurrent"
      title="当前定值已偏离有效版本：审批页与执行页使用同一有效版本，需重建并锁定新版本后才能下发。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
    />
    <el-alert
      v-if="staleScenarios.length || staleBaselines.length"
      :title="`定值变化触发级联失效：${staleScenarios.length} 个场景、${staleBaselines.length} 个会签基线需重算/复验。`"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
    />

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>待处理校验问题</h3>
          <el-button text type="primary" @click="router.push('/coordination')">查看全部</el-button>
        </div>
        <IssueTable
          :issues="issues.slice(0, 6)"
          :devices="devices"
          compact
          @select="router.push('/coordination')"
        />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>场景审校进度</h3>
          <el-tag effect="plain">{{ scenarios.length }} 个场景</el-tag>
        </div>
        <el-table :data="scenarios" max-height="320">
          <el-table-column prop="name" label="场景" min-width="190" />
          <el-table-column prop="operationMode" label="运行方式" width="120" />
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" effect="plain">
                {{ statusText(row.status) }}
              </el-tag>
              <el-tag
                v-if="row.basisChecksum && row.basisChecksum !== currentChecksum"
                type="danger"
                effect="plain"
                size="small"
                style="margin-left: 4px"
              >
                失效
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>断网合并与有效版本</h3>
        <div>
          <el-button text type="primary" @click="router.push('/sync')">进入断网合并中心</el-button>
          <el-button text type="primary" @click="router.push('/execution')">进入执行下发页</el-button>
        </div>
      </div>
      <el-table :data="offlinePackages.slice(0, 5)" max-height="260">
        <el-table-column prop="code" label="离线包" width="180" />
        <el-table-column prop="site" label="现场" min-width="150" />
        <el-table-column label="当前定值校验码" width="160">
          <template #default><span class="mono">{{ currentChecksum }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag
              :type="({ draft: 'info', sealed: 'warning', submitting: 'danger', merged: 'success' } as Record<string, string>)[row.status]"
              effect="plain"
            >
              {{ ({ draft: '草稿', sealed: '待回网', submitting: '中断可恢复', merged: '已合并' } as Record<string, string>)[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!offlinePackages.length" description="尚无离线包" :image-size="60" />
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>近期审计轨迹</h3>
        <el-tag effect="plain">只读时间线</el-tag>
      </div>
      <el-timeline>
        <el-timeline-item
          v-for="entry in data.audit.slice(0, 5)"
          :key="entry.id"
          :timestamp="new Date(entry.createdAt).toLocaleString('zh-CN')"
          placement="top"
        >
          <strong>{{ entry.action }}</strong>
          <span class="muted"> · {{ entry.target }} · {{ entry.operator }}</span>
          <p>{{ entry.detail }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>
  </div>
</template>
