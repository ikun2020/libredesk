<template>
  <ConversationPlaceholder v-if="isInboxList" />
  <router-view />
</template>

<script setup>
import { computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useIntervalFn, useDocumentVisibility, useEventListener } from '@vueuse/core'
import { useConversationStore } from '../../stores/conversation'
import { CONVERSATION_LIST_TYPE, CONVERSATION_DEFAULT_STATUSES } from '../../constants/conversation'
import ConversationPlaceholder from '@/features/conversation/ConversationPlaceholder.vue'
import { scheduleConversationDetailPreload } from '@main/router/conversation-detail'

const route = useRoute()
const type = computed(() => route.params.type)
const teamID = computed(() => route.params.teamID)
const viewID = computed(() => route.params.viewID)
const isInboxList = computed(() => ['inbox', 'team-inbox', 'view-inbox'].includes(route.name))

const conversationStore = useConversationStore()

let lastFetchedKey = ''

const storeHasCurrentList = () => {
  const c = conversationStore.conversations
  if (!c.initialized) return false
  if (viewID.value) return c.listType === CONVERSATION_LIST_TYPE.VIEW && String(c.viewID) === String(viewID.value)
  if (type.value) return c.listType === type.value
  if (teamID.value) return c.listType === CONVERSATION_LIST_TYPE.TEAM_UNASSIGNED && String(c.teamID) === String(teamID.value)
  return false
}

const fetchForCurrentRoute = () => {
  if (!type.value && !teamID.value && !viewID.value) return

  const key = `${type.value || ''}|${teamID.value || ''}|${viewID.value || ''}`
  if (key === lastFetchedKey) return
  lastFetchedKey = key

  // List already loaded: soft-refresh in place. A full fetch resets the list first and blanks it.
  if (storeHasCurrentList()) {
    conversationStore.refreshConversationList()
    return
  }

  if (viewID.value) {
    conversationStore.setListStatus('', false)
    conversationStore.fetchConversationsList(true, CONVERSATION_LIST_TYPE.VIEW, 0, [], viewID.value)
    return
  }

  if (!conversationStore.getListStatus) {
    conversationStore.setListStatus(CONVERSATION_DEFAULT_STATUSES.OPEN, false)
  }
  if (type.value) {
    conversationStore.fetchConversationsList(true, type.value)
  } else {
    conversationStore.fetchConversationsList(true, CONVERSATION_LIST_TYPE.TEAM_UNASSIGNED, teamID.value)
  }
}

onMounted(fetchForCurrentRoute)

const visibility = useDocumentVisibility()
const canPreloadDetail = computed(() =>
  isInboxList.value && visibility.value === 'visible' && storeHasCurrentList() &&
  !conversationStore.conversations.loading && !conversationStore.conversations.errorMessage &&
  conversationStore.conversations.data.length > 0
)
watch(canPreloadDetail, (ready, _, onCleanup) => {
  if (ready) onCleanup(scheduleConversationDetailPreload(() => canPreloadDetail.value))
}, { immediate: true, flush: 'post' })

const { pause, resume } = useIntervalFn(
  () => conversationStore.refreshConversationList(),
  120000
)
watch(visibility, v => {
  if (v === 'visible') {
    conversationStore.refreshInboxAfterResume()
    resume()
  } else {
    pause()
  }
})

useEventListener(window, 'pageshow', (event) => {
  if (event.persisted) conversationStore.refreshInboxAfterResume()
})

watch([type, teamID, viewID], fetchForCurrentRoute)
</script>
