<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  Connection,
  DataLine,
  DocumentChecked,
  Files,
  Operation,
  SetUp,
  Tickets,
  VideoPause,
} from '@element-plus/icons-vue'
import { useAppStateQuery } from '@/api/queries'
import { useAppStore } from '@/stores/app'
import { useSyncStore } from '@/stores/sync'

const route = useRoute()
const store = useAppStore()
const sync = useSyncStore()
const { data, isLoading, isError, error } = useAppStateQuery()

watch(
  data,
  async (state) => {
    if (state && !store.hydrated) {
      store.hydrate(state)
      // 载入调度端权威版本（首次会播种初始台账）
      await sync.pull()
    }
  },
  { immediate: true },
)

const title = computed(() => String(route.meta.title ?? '工作台'))
const menuItems = [
  { path: '/', label: '运行总览', icon: DataLine },
  { path: '/devices', label: '设备台账', icon: Files },
  { path: '/coordination', label: '配合校核', icon: DocumentChecked },
  { path: '/scenarios', label: '故障场景', icon: Operation },
  { path: '/baseline', label: '审批与基线', icon: Tickets },
  { path: '/execution', label: '定值执行', icon: VideoPause },
  { path: '/sync', label: '断网合并', icon: Connection },
  { path: '/audit', label: '审计与导出', icon: SetUp },
]
</script>

<template>
  <div v-if="isLoading && !store.hydrated" class="app-loading">
    <el-skeleton :rows="8" animated />
  </div>
  <el-result
    v-else-if="isError"
    icon="error"
    title="本地数据加载失败"
    :sub-title="error instanceof Error ? error.message : '请刷新后重试'"
  />
  <el-container v-else class="app-shell">
    <el-aside width="236px" class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">保</div>
        <div>
          <strong>继电保护审校</strong>
          <span>网省协同工作台</span>
        </div>
      </div>
      <el-menu :default-active="route.path" router class="side-menu">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <el-badge
            v-if="item.path === '/sync' && sync.pendingConflicts.length"
            :value="sync.pendingConflicts.length"
            class="menu-badge"
            type="danger"
          />
        </el-menu-item>
      </el-menu>
      <div class="sidebar-foot">
        <span>当前工程</span>
        <strong>2026 秋检保护方案</strong>
        <small>
          链路：<em :class="sync.online ? 'link-online' : 'link-offline'">
            {{ sync.online ? '在线（调度联通）' : '断网（现场离线）' }}
          </em>
        </small>
        <small v-if="sync.serverHeadRev">调度端修订流水号 #{{ sync.serverHeadRev }}</small>
      </div>
    </el-aside>
    <el-container>
      <el-header class="app-header">
        <div>
          <span class="header-context">电网继电保护定值配合与故障场景审校平台</span>
          <h1>{{ title }}</h1>
        </div>
        <div class="header-actions">
          <el-tag v-if="!sync.online" type="danger" effect="dark">断网中 · 离线包 {{ sync.offlineChanges.length }} 笔</el-tag>
          <el-tag v-else-if="sync.pendingConflicts.length" type="warning" effect="dark">
            {{ sync.pendingConflicts.length }} 个冲突待复核
          </el-tag>
          <el-tag v-if="store.saving || sync.busy" type="warning">正在写入</el-tag>
          <el-tag v-else type="success">数据已持久化</el-tag>
          <el-avatar :size="32">陈</el-avatar>
        </div>
      </el-header>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
