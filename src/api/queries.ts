import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import {
  applyDispatchChange,
  exportSettings,
  fetchBootstrap,
  importLegacyBatch,
  patchState,
  persistState,
  resetMockState,
  submitPackage,
} from './client'
import type { AppState } from '@/types/domain'
import type { SubmitPackageResponse } from './client'

export const appStateQueryKey = ['grid-protection-state'] as const

export function useAppStateQuery() {
  return useQuery({
    queryKey: appStateQueryKey,
    queryFn: fetchBootstrap,
    staleTime: 30_000,
  })
}

export function usePersistStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (state: AppState) => persistState(state),
    onSuccess: (state) => queryClient.setQueryData(appStateQueryKey, { state }),
  })
}

export function usePatchStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: patchState,
    onSuccess: (state: AppState) => queryClient.setQueryData(appStateQueryKey, { state }),
  })
}

export function useResetStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: resetMockState,
    onSuccess: (state) =>
      queryClient.setQueryData(appStateQueryKey, { state, backfilled: false, backfillNote: '' }),
  })
}

export function useExportMutation() {
  return useMutation({
    mutationFn: exportSettings,
  })
}

export function useSubmitPackageMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: submitPackage,
    onSuccess: (response: SubmitPackageResponse) =>
      queryClient.setQueryData(appStateQueryKey, { ...extractBootstrap(response.state) }),
  })
}

export function useDispatchChangeMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: applyDispatchChange,
    onSuccess: (state: AppState) =>
      queryClient.setQueryData(appStateQueryKey, { ...extractBootstrap(state) }),
  })
}

export function useLegacyImportMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: importLegacyBatch,
    onSuccess: (state: AppState) =>
      queryClient.setQueryData(appStateQueryKey, { ...extractBootstrap(state) }),
  })
}

function extractBootstrap(state: AppState) {
  return { state }
}

export function useIssueStats() {
  const query = useAppStateQuery()
  return computed(() => {
    const issues = query.data.value?.state.issues ?? []
    return {
      total: issues.length,
      high: issues.filter((issue) => issue.level === 'high').length,
      open: issues.filter((issue) => issue.status !== 'closed').length,
    }
  })
}
