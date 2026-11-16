<template>
  <LoadingOverlay :loading="formLoading" reserve-height>
    <AdminToolbar v-model:search="searchTerm" :searchable="!orderedMacros" class="mb-5">
      <template #actions>
        <template v-if="orderedMacros">
          <Button type="button" variant="outline" :disabled="savingOrder" @click="finishReordering()">
            {{ t('globals.messages.cancel') }}
          </Button>
          <Button type="button" :disabled="savingOrder || !orderChanged" @click="saveOrder">
            {{ t(savingOrder ? 'globals.messages.saving' : 'globals.messages.save') }}
          </Button>
        </template>
        <template v-else>
          <Button
            type="button"
            variant="outline"
            :disabled="formLoading || macros.length < 2"
            @click="orderedMacros = [...macros]"
          >
            <ArrowUpDown class="size-4" aria-hidden="true" />
            {{ t('macro.reorder') }}
          </Button>
          <router-link :to="{ name: 'new-macro' }">
            <Button>{{ t('macro.new') }}</Button>
          </router-link>
        </template>
      </template>
    </AdminToolbar>
    <template v-if="orderedMacros">
      <p class="mb-3 text-sm text-muted-foreground">{{ t('macro.reorderHelp') }}</p>
      <Draggable
        v-model="orderedMacros"
        tag="ol"
        item-key="id"
        handle=".macro-sort-handle"
        class="divide-y divide-border rounded-lg border border-border bg-card shadow-sm"
        ghost-class="opacity-40"
        :animation="reducedMotion === 'reduce' ? 0 : 150"
        :force-fallback="true"
        :fallback-on-body="true"
        :fallback-tolerance="3"
        :disabled="savingOrder"
        role="list"
        :aria-label="t('macro.reorder')"
        :aria-busy="savingOrder"
      >
        <template #item="{ element, index }">
          <li class="flex min-h-14 items-center gap-3 px-3 py-2">
            <span
              class="macro-sort-handle shrink-0 touch-none cursor-grab p-2 text-muted-foreground active:cursor-grabbing"
              aria-hidden="true"
            >
              <GripVertical class="size-4" />
            </span>
            <span class="min-w-0 flex-1 break-words text-sm font-medium">
              {{ element.name }}
              <span
                v-if="duplicateNames.has(element.name)"
                class="ml-1 whitespace-nowrap text-xs font-normal text-muted-foreground"
              >#{{ element.id }}</span>
            </span>
            <div class="flex shrink-0 items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="max-md:size-11"
                :aria-label="t('macro.moveUp', { name: orderLabel(element) })"
                :disabled="savingOrder || index === 0"
                @click="moveMacro(index, -1)"
              >
                <ChevronUp class="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="max-md:size-11"
                :aria-label="t('macro.moveDown', { name: orderLabel(element) })"
                :disabled="savingOrder || index === orderedMacros.length - 1"
                @click="moveMacro(index, 1)"
              >
                <ChevronDown class="size-4" aria-hidden="true" />
              </Button>
            </div>
          </li>
        </template>
      </Draggable>
    </template>
    <DataTable
      v-else
      v-model:search="searchTerm"
      :searchable="false"
      :columns="createColumns(t)"
      :data="macros"
      :loading="formLoading"
    />
  </LoadingOverlay>
</template>

<script setup>
import AdminToolbar from '@main/layouts/admin/AdminToolbar.vue'

import { computed, ref, onMounted, onUnmounted } from 'vue'
import { usePreferredReducedMotion } from '@vueuse/core'
import { ArrowUpDown, ChevronDown, ChevronUp, GripVertical } from 'lucide-vue-next'
import Draggable from 'vuedraggable'
import DataTable from '@main/components/datatable/DataTable.vue'
import { createColumns } from '@main/features/admin/macros/dataTableColumns.js'
import LoadingOverlay from '@main/components/layout/LoadingOverlay.vue'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents.js'
import { handleHTTPError } from '@shared-ui/utils/http.js'
import { Button } from '@shared-ui/components/ui/button'
import { useI18n } from 'vue-i18n'
import api from '@main/api'

const searchTerm = ref('')
const { t } = useI18n()
const formLoading = ref(false)
const macros = ref([])
const orderedMacros = ref(null)
const savingOrder = ref(false)
const reducedMotion = usePreferredReducedMotion()
const emitter = useEmitter()
let listRequest = 0
let pendingRefresh = false

const orderChanged = computed(() =>
  orderedMacros.value?.some((macro, index) => macro.id !== macros.value[index]?.id) ?? false
)
const duplicateNames = computed(() => {
  const seen = new Set()
  const duplicates = new Set()
  for (const { name } of macros.value) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return duplicates
})
const orderLabel = (macro) =>
  duplicateNames.value.has(macro.name) ? `${macro.name} #${macro.id}` : macro.name

onMounted(() => {
  getMacros()
  emitter.on(EMITTER_EVENTS.REFRESH_LIST, refreshList)
})

onUnmounted(() => {
  listRequest++
  emitter.off(EMITTER_EVENTS.REFRESH_LIST, refreshList)
})

const refreshList = (data) => {
  if (data?.model !== 'macros') return
  if (orderedMacros.value) pendingRefresh = true
  else getMacros()
}

const getMacros = async () => {
  const request = ++listRequest
  formLoading.value = true
  try {
    const resp = await api.getMacrosCompact()
    if (request === listRequest) macros.value = resp.data.data
  } catch (error) {
    if (request === listRequest) showError(error)
  } finally {
    if (request === listRequest) formLoading.value = false
  }
}

const showError = (error) => {
  emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
    variant: 'destructive',
    description: handleHTTPError(error).message
  })
}

const moveMacro = (index, offset) => {
  const rows = orderedMacros.value
  const target = index + offset
  if (savingOrder.value || !rows || target < 0 || target >= rows.length) return
  const [macro] = rows.splice(index, 1)
  rows.splice(target, 0, macro)
}

const finishReordering = (refresh = false) => {
  orderedMacros.value = null
  if (refresh || pendingRefresh) {
    pendingRefresh = false
    getMacros()
  }
}

const saveOrder = async () => {
  if (savingOrder.value || !orderChanged.value) return
  const request = listRequest
  const sorted = [...orderedMacros.value]
  savingOrder.value = true
  try {
    await api.updateMacroOrder(sorted.map((macro) => macro.id))
    if (request !== listRequest) return
    macros.value = sorted
    finishReordering(true)
    emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
      description: t('globals.messages.savedSuccessfully')
    })
  } catch (error) {
    if (request === listRequest) showError(error)
  } finally {
    savingOrder.value = false
  }
}
</script>
