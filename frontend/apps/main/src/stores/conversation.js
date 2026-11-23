import { defineStore } from 'pinia'
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { handleHTTPError } from '@shared-ui/utils/http.js'
import { TYPING_RECEIVE_TIMEOUT } from '@shared-ui/composables/useTypingIndicator.js'
import { deepMerge } from '@shared-ui/utils/object.js'
import { getContactDisplayName } from '@main/utils/contact-display-name'
import { computeRecipientsFromMessage } from '@main/utils/email-recipients'
import { extractEmailAddress, resolveEmailSender, sendableAddresses } from '@main/utils/email-sender'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents'
import { subscribeToConversation, sendTypingIndicator, subscribeListReplace } from '@main/websocket'
import { playNotificationSound } from '@shared-ui/composables/useNotificationSound'
import MessageCache from '@main/utils/conversation-message-cache'
import { getI18n } from '@main/i18n'
import { CONVERSATION_LIST_TYPE, CONVERSATION_DEFAULT_STATUSES, TAG_ACTION } from '@/constants/conversation'
import { useThrottleFn, useStorage } from '@vueuse/core'
import { useUserStore } from '@/stores/user'
import { useUsersStore } from '@/stores/users'
import { useNotificationStore } from '@/stores/notification'
import { delayedLoading } from '@/utils/delayed-loading'
import api from '@main/api'

export const useConversationStore = defineStore('conversation', () => {
  const CONV_LIST_PAGE_SIZE = 25
  const MESSAGE_LIST_PAGE_SIZE = 30
  const OUTGOING_STATUS_CHECK_DELAYS = [1000, 4000, 10000]
  const priorities = ref([])
  const statuses = ref([])
  const currentTo = ref([])
  const currentBCC = ref([])
  const currentCC = ref([])
  const currentFrom = ref('')
  const currentFromOptions = ref([])
  const macros = ref({})
  const drafts = ref(new Map())
  // In-memory, resets on reload.
  const selectedDraftType = ref(new Map())
  let resolveDraftsReady
  const draftsReady = new Promise((resolve) => { resolveDraftsReady = resolve })
  const userStore = useUserStore()
  const usersStore = useUsersStore()
  const notificationStore = useNotificationStore()
  const router = useRouter()
  const isViewingConversation = (uuid) => router.currentRoute.value.params.uuid === uuid

  const selectedUUIDs = ref(new Set())
  const readStates = new Map()

  const sidebarCounts = reactive({
    assigned: 0,
    mentioned: 0,
    unassigned: 0,
    all: 0,
    views: {}
  })

  // Route changes reuse a count younger than the TTL; mutations and WS events pass force.
  const SIDEBAR_COUNTS_TTL = 45_000
  let sidebarCountsRequest = null
  let sidebarCountsFetchedAt = 0
  let sidebarCountsForceQueued = false

  async function fetchSidebarCounts ({ force = false } = {}) {
    if (sidebarCountsRequest) {
      // A request already in flight may have read the DB before this caller's mutation committed.
      if (force) sidebarCountsForceQueued = true
      return sidebarCountsRequest
    }
    if (!force && Date.now() - sidebarCountsFetchedAt < SIDEBAR_COUNTS_TTL) return

    sidebarCountsRequest = (async () => {
      try {
        const resp = await api.getSidebarCounts()
        const data = resp?.data?.data
        if (!data) return
        sidebarCounts.assigned = data.assigned || 0
        sidebarCounts.mentioned = data.mentioned || 0
        sidebarCounts.unassigned = data.unassigned || 0
        sidebarCounts.all = data.all || 0
        sidebarCounts.views = data.views || {}
        sidebarCountsFetchedAt = Date.now()
      } catch {
        // The sidebar works without counts.
      } finally {
        sidebarCountsRequest = null
        if (sidebarCountsForceQueued) {
          sidebarCountsForceQueued = false
          fetchSidebarCounts({ force: true })
        }
      }
    })()

    return sidebarCountsRequest
  }

  async function fetchViewCount (viewID) {
    try {
      const resp = await api.getViewCount(viewID)
      sidebarCounts.views[viewID] = resp?.data?.data?.count || 0
    } catch {
      // The sidebar works without counts.
    }
  }

  // WS events burst one per conversation; leading + trailing keeps it to two requests per burst.
  const SIDEBAR_COUNTS_EVENT_THROTTLE = 45_000
  const refreshSidebarCounts = useThrottleFn(
    () => fetchSidebarCounts({ force: true }),
    SIDEBAR_COUNTS_EVENT_THROTTLE,
    true
  )

  const priorityOptions = computed(() => {
    return priorities.value.map(p => ({ label: p.name, value: p.id }))
  })
  const statusOptions = computed(() => {
    return statuses.value.map(s => ({ label: s.name, value: s.id }))
  })
  const statusOptionsNoSnooze = computed(() =>
    statuses.value.filter(s => s.name !== CONVERSATION_DEFAULT_STATUSES.SNOOZED).map(s => ({
      label: s.name,
      value: s.id
    }))
  )

  let lastClickedUUID = null

  const selectedCount = computed(() => selectedUUIDs.value.size)
  const allSelected = computed(() => {
    const list = conversationsList.value
    return list.length > 0 && selectedUUIDs.value.size === list.length
  })

  function toggleSelect (uuid, shiftKey = false) {
    const next = new Set(selectedUUIDs.value)

    if (shiftKey && lastClickedUUID && lastClickedUUID !== uuid) {
      const list = conversationsList.value
      const lastIdx = list.findIndex(c => c.uuid === lastClickedUUID)
      const curIdx = list.findIndex(c => c.uuid === uuid)
      if (lastIdx !== -1 && curIdx !== -1) {
        const start = Math.min(lastIdx, curIdx)
        const end = Math.max(lastIdx, curIdx)
        for (let i = start; i <= end; i++) {
          next.add(list[i].uuid)
        }
      }
    } else {
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
    }

    lastClickedUUID = uuid
    selectedUUIDs.value = next
  }

  function selectAll () {
    selectedUUIDs.value = new Set(conversationsList.value.map(c => c.uuid))
  }

  function clearSelection () {
    selectedUUIDs.value = new Set()
    lastClickedUUID = null
  }

  function isSelected (uuid) {
    return selectedUUIDs.value.has(uuid)
  }

  // TODO: Move to constants.
  const sortFieldMap = {
    oldest: {
      model: 'conversations',
      field: 'last_message_at',
      order: 'asc'
    },
    newest: {
      model: 'conversations',
      field: 'last_message_at',
      order: 'desc'
    },
    started_first: {
      model: 'conversations',
      field: 'created_at',
      order: 'asc'
    },
    started_last: {
      model: 'conversations',
      field: 'created_at',
      order: 'desc'
    },
    waiting_longest: {
      model: 'conversations',
      field: 'waiting_since',
      order: 'asc'
    },
    next_sla_target: {
      model: 'conversations',
      field: 'next_sla_deadline_at',
      order: 'asc'
    },
    priority_first: {
      model: 'conversations',
      field: 'priority_id',
      order: 'desc'
    }
  }

  const sortFieldI18nKeys = {
    oldest: 'conversation.sort.oldestActivity',
    newest: 'conversation.sort.newestActivity',
    started_first: 'conversation.sort.startedFirst',
    started_last: 'conversation.sort.startedLast',
    waiting_longest: 'conversation.sort.waitingLongest',
    next_sla_target: 'conversation.sort.nextSLATarget',
    priority_first: 'conversation.sort.priorityFirst'
  }

  const persistedListStatus = useStorage('conversationListStatus', CONVERSATION_DEFAULT_STATUSES.OPEN)
  const persistedListSortField = useStorage('conversationListSortField', 'newest')
  if (!sortFieldMap[persistedListSortField.value]) {
    persistedListSortField.value = 'newest'
  }

  let typingTimeout = null
  const typingByUUID = reactive({})
  const typingTimeoutsByUUID = new Map()

  const conversations = reactive({
    data: [],
    listType: null,
    status: persistedListStatus.value,
    sortField: persistedListSortField.value,
    listFilters: [],
    viewID: 0,
    teamID: 0,
    loading: false,
    fetching: false,
    initialized: false,
    page: 1,
    hasMore: false,
    total: 0,
    errorMessage: ''
  })

  const conversation = reactive({
    data: null,
    loading: false,
    errorMessage: '',
    isTyping: false
  })

  const messages = reactive({
    data: new MessageCache(),
    pending: new Map(),
    fetchingLatest: false,
    loading: false,
    fetching: false,
    page: 1,
    // To trigger reactivity on the messages cache, simpler than making MessageCache reactive.
    version: 0,
  })

  // Convos whose message cache is stale; drained lazily by fetchMessages on next open.
  const staleConversationUUIDs = new Set()
  const CONVERSATION_CACHE_MAX = 50
  const conversationDataCache = new Map()

  function cacheConversationData (uuid, data) {
    if (!uuid || !data) return
    if (conversationDataCache.has(uuid)) conversationDataCache.delete(uuid)
    conversationDataCache.set(uuid, data)
    while (conversationDataCache.size > CONVERSATION_CACHE_MAX) {
      const oldest = conversationDataCache.keys().next().value
      if (oldest === conversation.data?.uuid) break
      conversationDataCache.delete(oldest)
    }
  }
  let activeListLoad = null
  let activeConversationLoad = null
  let activeMessageLoad = null
  const emitter = useEmitter()

  const incrementMessageVersion = () => setTimeout(() => messages.version++, 0)

  function setListStatus (status, fetch = true) {
    conversations.status = status
    // Views clear the status, so only a real selection updates the remembered one.
    if (status) {
      persistedListStatus.value = status
    }
    if (fetch) {
      resetConversations()
      reFetchConversationsList()
    }
  }

  const getListStatus = computed(() => {
    return conversations.status
  })

  function setListSortField (field) {
    if (conversations.sortField === field) return
    conversations.sortField = field
    persistedListSortField.value = field
    resetConversations()
    reFetchConversationsList()
  }

  const getListSortField = computed(() => {
    const i18n = getI18n()
    const t = i18n?.global?.t || ((key) => key.split('.').pop())
    return t(sortFieldI18nKeys[conversations.sortField])
  })


  async function fetchStatuses () {
    if (statuses.value.length > 0) return
    try {
      const response = await api.getStatuses()
      statuses.value = response.data.data.map(status => ({
        ...status,
        id: status.id.toString()
      }))
      // A remembered status can point at one that has since been deleted.
      if (conversations.status && !statuses.value.some(s => s.name === conversations.status)) {
        setListStatus(CONVERSATION_DEFAULT_STATUSES.OPEN)
      }
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function fetchPriorities () {
    if (priorities.value.length > 0) return
    try {
      const response = await api.getPriorities()
      priorities.value = response.data.data.map(priority => ({
        ...priority,
        id: priority.id.toString()
      }))
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  function matchesAssignmentScope (conv) {
    switch (conversations.listType) {
      case CONVERSATION_LIST_TYPE.ASSIGNED:
        return conv.assigned_user_id === userStore.userID
      case CONVERSATION_LIST_TYPE.UNASSIGNED:
        return !conv.assigned_user_id && !conv.assigned_team_id
      case CONVERSATION_LIST_TYPE.TEAM_UNASSIGNED:
        return Number(conv.assigned_team_id) === Number(conversations.teamID) && !conv.assigned_user_id
      default:
        return null
    }
  }

  function belongsToList (conv) {
    const matched = matchesAssignmentScope(conv)
    return matched === null ? true : matched
  }

  const conversationsList = computed(() => {
    if (!conversations.data) return []
    let filteredConversations = conversations.data
    if (conversations.status !== "") {
      filteredConversations = filteredConversations.filter(conv => conv.status === conversations.status)
    }
    filteredConversations = filteredConversations.filter(belongsToList)

    return [...filteredConversations].sort((a, b) => {
      const field = sortFieldMap[conversations.sortField]?.field
      if (!a[field] && !b[field]) return 0
      if (!a[field]) return 1       // null goes last
      if (!b[field]) return -1
      const order = sortFieldMap[conversations.sortField]?.order
      return order === 'asc'
        ? new Date(a[field]) - new Date(b[field])
        : new Date(b[field]) - new Date(a[field])
    })
  })

  const currentConversationHasMoreMessages = computed(() => {
    return messages.data.hasMore(conversation.data?.uuid)
  })

  const conversationMessages = computed(() => {
    return messages.data.getAllPagesMessages(conversation.data?.uuid)
  })

  function applyConversationRead (state) {
    const { conversation_uuid: uuid, last_seen_at: lastSeenAt, read_version: readVersion, is_unread: isUnread } = state
    const previous = readStates.get(uuid)
    if (previous && readVersion <= previous.read_version) return
    readStates.set(uuid, state)
    notificationStore.refreshConversationRead(uuid)
    const row = conversations.data.find(conv => conv.uuid === uuid)
    if (row && isUnread) {
      row.unread_message_count = Math.max(1, row.unread_message_count || 0)
    } else if (row && Date.parse(row.last_message_at) <= Date.parse(lastSeenAt)) {
      row.unread_message_count = 0
    }
  }

  async function markAsUnread (uuid) {
    try {
      const response = await api.markConversationAsUnread(uuid)
      applyConversationRead(response.data.data)
    } catch (err) {
      handleHTTPError(err)
    }
  }

  function incrementUnread (uuid, createdAt) {
    const row = conversations.data.find(c => c.uuid === uuid)
    if (!row || Date.parse(createdAt) <= Date.parse(readStates.get(uuid)?.last_seen_at)) return
    row.unread_message_count = Math.min((row.unread_message_count || 0) + 1, 10)
  }

  const currentContactName = computed(() => getContactDisplayName(conversation.data?.contact))

  const current = computed(() => {
    return conversation.data || {}
  })

  const isConversationOpen = computed(() => {
    return Object.keys(conversation.data || {}).length > 0
  })

  watchEffect(async () => {
    const _ = messages.version // eslint-disable-line no-unused-vars
    const conv = conversation.data
    const msgData = messages.data
    const inboxEmail = extractEmailAddress(conv?.inbox_mail)

    // Recipients only exist for email conversations.
    if (conv && conv.inbox_channel !== 'email') {
      currentTo.value = []
      currentCC.value = []
      currentBCC.value = []
      currentFrom.value = ''
      currentFromOptions.value = []
      return
    }

    if (!conv || !msgData || !inboxEmail) {
      currentFrom.value = ''
      currentFromOptions.value = []
      return
    }

    const aliases = Array.isArray(conv.inbox_aliases) ? conv.inbox_aliases : []
    const receivingAddresses = [inboxEmail, ...aliases.map(alias => alias.email)].filter(Boolean)
    const senders = sendableAddresses(conv.inbox_mail, aliases)
    currentFromOptions.value = senders

    // Skip automated messages (auto-replies, CSAT) so the prefill reflects the last human-driven recipients.
    const latestMessage = msgData.getLatestMessage(conv.uuid, ['incoming', 'outgoing'], true, true)
    if (!latestMessage) {
      currentTo.value = []
      currentCC.value = []
      currentBCC.value = []
      currentFrom.value = senders[0] || ''
      return
    }

    const lastSent = msgData.getLatestMessage(conv.uuid, ['outgoing'], true, false)
    currentFrom.value = resolveEmailSender(lastSent || latestMessage, senders)
    const { to, cc, bcc } = computeRecipientsFromMessage(
      latestMessage,
      conv.contact?.email || '',
      [...receivingAddresses, conv?.inbox_reply_to].filter(Boolean)
    )
    currentTo.value = to
    currentCC.value = cc
    currentBCC.value = bcc
  })

  function resetTypingState () {
    conversation.isTyping = false
    if (typingTimeout) {
      clearTimeout(typingTimeout)
      typingTimeout = null
    }
  }

  function rememberAssignee (conv) {
    if (conv.assignee?.id > 0) usersStore.upsertUsers([conv.assignee])
  }

  async function fetchConversation (uuid) {
    activeConversationLoad?.guard?.cancel()
    const load = {}
    activeConversationLoad = load
    conversation.errorMessage = ''
    const cached = conversationDataCache.get(uuid)
    if (cached) {
      conversation.data = cached
      resetTypingState()
      subscribeToConversation(uuid)
      silentRefetchConversation(uuid, load)
      return
    }
    load.guard = delayedLoading(conversation, 'loading', 300, 0)
    try {
      const resp = await api.getConversation(uuid)
      if (activeConversationLoad !== load) return
      rememberAssignee(resp.data.data)
      conversation.data = resp.data.data
      resetTypingState()
      subscribeToConversation(uuid)
      cacheConversationData(uuid, conversation.data)
    } catch (error) {
      if (activeConversationLoad !== load) return
      const result = handleHTTPError(error)
      if (result.canceled) return
      conversation.errorMessage = result.message
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: conversation.errorMessage
      })
    } finally {
      if (activeConversationLoad === load) load.guard.release()
    }
  }

  async function silentRefetchConversation (uuid, load) {
    try {
      const resp = await api.getConversation(uuid)
      if (activeConversationLoad === load && conversation.data?.uuid === uuid) {
        rememberAssignee(resp.data.data)
        deepMerge(conversation.data, resp.data.data)
        cacheConversationData(uuid, conversation.data)
        if (isViewingConversation(uuid) && hasNewerMessages(uuid, resp.data.data.last_message_at)) {
          refreshOpenMessages(uuid)
        }
      }
    } catch (error) {
      if (activeConversationLoad === load && !handleHTTPError(error).canceled) {
        console.warn('silent conversation refetch failed', error)
      }
    }
  }

  const hasPendingMessages = computed(() => [...messages.pending.values()].includes(conversation.data?.uuid))

  function clearPendingMessages (uuid) {
    for (const [messageUUID, conversationUUID] of messages.pending) {
      if (conversationUUID === uuid && messages.data.hasMessage(uuid, messageUUID)) messages.pending.delete(messageUUID)
    }
  }

  function hasNewerMessages (uuid, timestamp) {
    const time = Date.parse(timestamp)
    return time > 0 && time > messages.data.getLatestPersistedAt(uuid)
  }

  async function fetchRecentMessages (load, reloadHistory) {
    const { uuid } = load
    const latestFetchedAt = messages.data.getLatestFetchedAt(uuid)
    const minimumPages = reloadHistory ? messages.data.getLastFetchedPage(uuid) : 1
    const historyTail = reloadHistory ? messages.data.getHistoryTail(uuid) : undefined
    let reachedHistoryTail = !historyTail
    const pages = []
    for (let page = 1; ; page++) {
      const response = await api.getConversationMessages(uuid, { page, page_size: MESSAGE_LIST_PAGE_SIZE })
      if (activeMessageLoad !== load) return
      const result = response.data?.data || {}
      const results = result.results || []
      pages.push({ page, results, totalPages: result.total_pages })
      reachedHistoryTail ||= results.some(message => message.uuid === historyTail)
      // After a longer pause, continue until the new pages meet the cached history.
      if (!results.length || page >= (result.total_pages || 1) ||
          (page >= minimumPages && reachedHistoryTail && (!latestFetchedAt ||
            results.some(message => Date.parse(message.created_at) <= latestFetchedAt)))) break
    }

    const newestAdded = pages.flatMap(page => page.results)
      .find(message => !message.recalled_at && !messages.data.hasMessage(uuid, message.uuid) &&
        (!reloadHistory || Date.parse(message.created_at) > latestFetchedAt))
    let changed = false
    for (const { page, results, totalPages } of pages) {
      changed = messages.data.addMessages(uuid, results, page, totalPages) || changed
    }
    staleConversationUUIDs.delete(uuid)
    clearPendingMessages(uuid)
    if (changed) incrementMessageVersion()
    if (newestAdded) {
      setTimeout(() => {
        emitter.emit(EMITTER_EVENTS.NEW_MESSAGE, { conversation_uuid: uuid, message: newestAdded })
      }, 100)
    }
  }

  async function fetchMessages (uuid, fetchNextPage = false, refresh = false) {
    activeMessageLoad?.guard?.cancel()
    const load = { uuid, fetchNextPage }
    activeMessageLoad = load
    messages.fetching = false
    messages.fetchingLatest = false
    const cachedHistory = messages.data.getLastFetchedPage(uuid) > 0
    const listRow = conversations.data.find(conversation => conversation.uuid === uuid)
    const listTimestamp = listRow?.last_message_at
    const detail = conversation.data?.uuid === uuid ? conversation.data : conversationDataCache.get(uuid)
    // Edits and older recalls keep the last-send timestamp unchanged, so revalidate cached chat pages.
    const reloadHistory = (detail?.inbox_channel || listRow?.inbox_channel) === 'livechat'
    if (!fetchNextPage && cachedHistory &&
        (reloadHistory || refresh || staleConversationUUIDs.has(uuid) || hasNewerMessages(uuid, listTimestamp))) {
      messages.fetchingLatest = true
      try {
        await fetchRecentMessages(load, reloadHistory)
      } catch (error) {
        if (activeMessageLoad !== load) return
        const result = handleHTTPError(error)
        if (!result.canceled) {
          emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
            variant: 'destructive',
            description: result.message
          })
        }
      } finally {
        if (activeMessageLoad === load) messages.fetchingLatest = false
      }
    }

    if (!fetchNextPage && messages.data.getLastFetchedPage(uuid) > 0) {
      return
    }

    if (!fetchNextPage) load.guard = delayedLoading(messages, 'loading', 300, 0)
    messages.fetching = true
    const page = messages.data.getLastFetchedPage(uuid) + 1
    try {
      const response = await api.getConversationMessages(uuid, { page, page_size: MESSAGE_LIST_PAGE_SIZE })
      if (activeMessageLoad !== load) return
      const result = response.data?.data || {}
      messages.data.addMessages(uuid, result.results || [], result.page, result.total_pages)
      if (!fetchNextPage) staleConversationUUIDs.delete(uuid)
      clearPendingMessages(uuid)
      incrementMessageVersion()
    } catch (error) {
      if (activeMessageLoad !== load) return
      const result = handleHTTPError(error)
      if (!result.canceled) {
        emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
          variant: 'destructive',
          description: result.message
        })
      }
    } finally {
      if (activeMessageLoad === load) {
        load.guard?.release()
        messages.fetching = false
      }
    }
  }

  async function fetchNextMessages () {
    const uuid = conversation.data?.uuid
    if (uuid && isViewingConversation(uuid) && !messages.fetchingLatest) return fetchMessages(uuid, true)
  }

  function refreshOpenMessages (uuid) {
    if (activeMessageLoad?.uuid === uuid && !activeMessageLoad.fetchNextPage &&
        (messages.fetching || messages.fetchingLatest)) return
    return fetchMessages(uuid, false, true)
  }

  function ensureLinkedMessage (uuid, messageUUID) {
    if (typeof messageUUID !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(messageUUID)) return
    if (isViewingConversation(uuid) && !messages.data.hasMessage(uuid, messageUUID)) {
      return fetchMessage(uuid, messageUUID)
    }
  }

  function refreshInboxAfterResume () {
    const { name, params } = router.currentRoute.value
    if (document.hidden || !/^(?:(?:team|view)-)?inbox(?:-conversation)?$/.test(String(name))) return
    if (!conversations.fetching) fetchFirstPageConversations()
    if (params.uuid) refreshOpenMessages(params.uuid)
  }

  async function fetchMessage (conversationUUID, messageUUID) {
    messages.pending.set(messageUUID, conversationUUID)
    try {
      const response = await api.getConversationMessage(conversationUUID, messageUUID)
      if (response?.data?.data) {
        const newMsg = response.data.data
        messages.data.addMessage(conversationUUID, newMsg)
        messages.pending.delete(messageUUID)
        incrementMessageVersion()
        const cached = messages.data.getMessage(conversationUUID, messageUUID)
        return cached?.recalled_at ? undefined : cached
      }
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
    staleConversationUUIDs.add(conversationUUID)
    const isCurrent = conversation.data?.uuid === conversationUUID && isViewingConversation(conversationUUID)
    if (isCurrent) await fetchMessages(conversationUUID)
    if (!isCurrent || !staleConversationUUIDs.has(conversationUUID)) messages.pending.delete(messageUUID)
    return messages.data.getAllPagesMessages(conversationUUID).find(message => message.uuid === messageUUID)
  }

  async function deleteMessage (conversationUUID, messageUUID) {
    try {
      const resp = await api.deleteMessage(conversationUUID, messageUUID)
      const deletedText = resp.data.data.content
      const existing = messages.data.getAllPagesMessages(conversationUUID).find(m => m.uuid === messageUUID)
      messages.data.updateMessage(conversationUUID, messageUUID, {
        content: deletedText,
        text_content: deletedText,
        meta: { ...(existing?.meta || {}), deleted_at: new Date().toISOString() }
      })
      incrementMessageVersion()
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function updateLiveChatMessage (request) {
    try {
      const response = await request()
      mergeMessageUpdate(response.data.data)
      return true
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
      return false
    }
  }

  function editLiveChatMessage (conversationUUID, messageUUID, content) {
    return updateLiveChatMessage(() => api.editLiveChatMessage(conversationUUID, messageUUID, content))
  }

  function recallLiveChatMessage (conversationUUID, messageUUID) {
    return updateLiveChatMessage(() => api.recallLiveChatMessage(conversationUUID, messageUUID))
  }

  function fetchNextConversations () {
    if (conversations.fetching || !conversations.hasMore) return
    fetchConversationsList(false, conversations.listType, conversations.teamID, conversations.listFilters, conversations.viewID, conversations.page + 1)
  }

  function reFetchConversationsList (showLoader = true) {
    fetchConversationsList(showLoader, conversations.listType, conversations.teamID, conversations.listFilters, conversations.viewID, conversations.page)
  }

  async function fetchFirstPageConversations () {
    await fetchConversationsList(false, conversations.listType, conversations.teamID, conversations.listFilters, conversations.viewID, 1)
  }

  function cancelListLoad () {
    if (!activeListLoad) return
    activeListLoad.controller.abort()
    activeListLoad.guard?.cancel()
    activeListLoad = null
    conversations.fetching = false
  }

  async function fetchConversationsList (showLoader = true, listType = null, teamID = 0, filters = [], viewID = 0, page = 0) {
    if (!listType) return
    if (conversations.listType !== listType || conversations.teamID !== teamID || conversations.viewID !== viewID) {
      resetConversations()
    }
    conversations.listType = listType
    conversations.teamID = teamID
    conversations.viewID = viewID
    if (conversations.status) {
      filters = filters.filter(f => f.model !== 'conversation_statuses')
      filters.push({
        model: 'conversation_statuses',
        field: 'name',
        operator: 'equals',
        value: conversations.status
      })
    }
    conversations.listFilters = filters
    // A conversation route change can leave the inbox list itself unchanged.
    cancelListLoad()
    const load = {
      controller: new AbortController(),
      guard: showLoader ? delayedLoading(conversations, 'loading', 300, 0) : null,
      refreshQueued: false
    }
    activeListLoad = load
    conversations.fetching = true
    if (page === 0) page = conversations.page
    try {
      conversations.errorMessage = ''
      const response = await makeConversationListRequest(listType, teamID, viewID, filters, page, load.controller.signal)
      if (activeListLoad !== load) return
      processConversationListResponse(response)
    } catch (error) {
      if (activeListLoad !== load) return
      if (conversations.data.length === 0) {
        conversations.errorMessage = handleHTTPError(error).message
        conversations.total = 0
      }
    } finally {
      if (activeListLoad === load) {
        load.guard?.release()
        activeListLoad = null
        conversations.initialized = true
        conversations.fetching = false
        if (load.refreshQueued) void fetchFirstPageConversations()
      }
    }
  }

  function makeConversationListRequest (listType, teamID, viewID, filters, page, signal) {
    const sort = sortFieldMap[conversations.sortField]
    const params = { page, page_size: CONV_LIST_PAGE_SIZE, order_by: `${sort.model}.${sort.field}`, order: sort.order }
    if (listType !== CONVERSATION_LIST_TYPE.VIEW) params.filters = filters.length > 0 ? JSON.stringify(filters) : []
    switch (listType) {
      case CONVERSATION_LIST_TYPE.ASSIGNED:
        return api.getAssignedConversations(params, signal)
      case CONVERSATION_LIST_TYPE.UNASSIGNED:
        return api.getUnassignedConversations(params, signal)
      case CONVERSATION_LIST_TYPE.ALL:
        return api.getAllConversations(params, signal)
      case CONVERSATION_LIST_TYPE.TEAM_UNASSIGNED:
        return api.getTeamUnassignedConversations(teamID, params, signal)
      case CONVERSATION_LIST_TYPE.VIEW:
        return api.getViewConversations(viewID, params, signal)
      case CONVERSATION_LIST_TYPE.MENTIONED:
        return api.getMentionedConversations(params, signal)
      default:
        throw new Error('Invalid conversation list type: ' + listType)
    }
  }

  function trimListToCurrentPage () {
    const maxLen = conversations.page * CONV_LIST_PAGE_SIZE
    if (conversations.data.length > maxLen) {
      conversations.data.splice(maxLen)
    }
  }

  function mergeIntoList (uuid, payload) {
    const existing = conversations.data?.find(c => c.uuid === uuid)
    if (existing) deepMerge(existing, payload)
    return existing
  }

  function processConversationListResponse (response) {
    const apiResponse = response.data.data
    const newConversations = []
    for (const conv of apiResponse.results) {
      rememberAssignee(conv)
      if (!mergeIntoList(conv.uuid, conv)) newConversations.push(conv)
    }
    conversations.page = Math.max(conversations.page, apiResponse.page)
    conversations.hasMore = apiResponse.total_pages > conversations.page
    if (!conversations.data) conversations.data = []
    if (apiResponse.page === 1) {
      conversations.data.unshift(...newConversations)
    } else {
      conversations.data.push(...newConversations)
    }
    conversations.total = apiResponse.total

    trimListToCurrentPage()

    const openUUID = router.currentRoute.value.params.uuid
    const openRow = apiResponse.results.find(row => row.uuid === openUUID)
    if (openRow && hasNewerMessages(openUUID, openRow.last_message_at)) refreshOpenMessages(openUUID)

    // Re-check document.hidden in case the user returned while the refresh was in flight.
    if (pendingNotificationUUIDs.size > 0) {
      let shouldPlay = false
      for (const uuid of pendingNotificationUUIDs) {
        if (isConversationInList(uuid)) {
          shouldPlay = true
        }
      }
      pendingNotificationUUIDs.clear()
      if (shouldPlay && document.hidden) {
        playNotificationSound()
      }
    }
  }

  async function updatePriority (v) {
    try {
      await api.updateConversationPriority(conversation.data.uuid, { priority: v })
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function updateStatus (uuid, v) {
    if (!uuid) return
    const isCurrent = () => conversation.data?.uuid === uuid
    const previous = isCurrent() ? conversation.data.status : null
    if (isCurrent()) conversation.data.status = v
    try {
      await api.updateConversationStatus(uuid, { status: v })
      notificationStore.markAssignmentAsReadForConversation(uuid)
      fetchSidebarCounts({ force: true })
    } catch (error) {
      if (previous !== null && isCurrent()) conversation.data.status = previous
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function snoozeConversation (snoozeDuration) {
    try {
      await api.updateConversationStatus(conversation.data.uuid, { status: CONVERSATION_DEFAULT_STATUSES.SNOOZED, snoozed_until: snoozeDuration })
      fetchSidebarCounts({ force: true })
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  function applyTagsLocally (uuid, action, tags) {
    const targets = []
    const listConv = conversations.data?.find(c => c.uuid === uuid)
    if (listConv) targets.push(listConv)
    if (conversation.data?.uuid === uuid) targets.push(conversation.data)

    for (const conv of targets) {
      if (!Array.isArray(conv.tags)) conv.tags = []
      if (action === TAG_ACTION.ADD) {
        for (const t of tags) {
          if (!conv.tags.includes(t)) conv.tags.push(t)
        }
      } else if (action === TAG_ACTION.SET) {
        conv.tags = [...tags]
      } else if (action === TAG_ACTION.REMOVE) {
        conv.tags = conv.tags.filter(t => !tags.includes(t))
      }
    }
  }

  async function updateConversationTags (uuid, action, tags) {
    const source = conversation.data?.uuid === uuid
      ? conversation.data
      : conversations.data?.find(c => c.uuid === uuid)
    const previous = source ? [...(source.tags || [])] : null
    applyTagsLocally(uuid, action, tags)
    try {
      await api.upsertTags(uuid, { action, tags })
    } catch (error) {
      if (previous) applyTagsLocally(uuid, TAG_ACTION.SET, previous)
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
      throw error
    }
  }

  async function updateAssignee (type, v) {
    const conv = conversation.data
    try {
      const teamChanged =
        type === 'team' && Number(conv.assigned_team_id) !== Number(v.assignee_id)
      await api.updateAssignee(conv.uuid, type, v)
      conv[`assigned_${type}_id`] = v.assignee_id
      // Backend clears the user assignee when the team changes.
      if (teamChanged) conv.assigned_user_id = null
      fetchSidebarCounts({ force: true })
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function removeAssignee (type) {
    const conv = conversation.data
    try {
      await api.removeAssignee(conv.uuid, type)
      conv[`assigned_${type}_id`] = null
      fetchSidebarCounts({ force: true })
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  async function updateAssigneeLastSeen (uuid, messageUUID) {
    if (!isViewingConversation(uuid)) return
    const response = await api.updateAssigneeLastSeen(uuid, messageUUID)
    applyConversationRead(response.data.data)
  }

  function isConversationInList (uuid) {
    return Boolean(conversations.data?.find(c => c.uuid === uuid))
  }

  const pendingNotificationUUIDs = new Set()

  function addPendingNotification (uuid) {
    pendingNotificationUUIDs.add(uuid)
  }

  // trailing=true: fires one final refresh after a burst so the list converges to latest state.
  const throttledFetchFirstPage = useThrottleFn(() => {
    if (activeListLoad) {
      activeListLoad.refreshQueued = true
      return
    }
    return fetchFirstPageConversations()
  }, 60000, true)

  function refreshConversationList () {
    throttledFetchFirstPage()
  }

  function updateConversationLastMessage (uuid, message) {
    const conv = conversations.data?.find(c => c.uuid === uuid)
    if (!conv) return
    conv.last_message = message.text_content || message.content || getMediaPreview(message.attachments)
    conv.last_message_at = message.created_at
    conv.last_message_sender = message.sender_type
  }

  async function updateConversationMessage (message) {
    if (conversation.data?.uuid !== message.conversation_uuid) {
      // Lazy invalidation: refresh the cache when the user next opens this convo, not on every WS event.
      if (messages.data.hasConversation(message.conversation_uuid)) {
        staleConversationUUIDs.add(message.conversation_uuid)
      }
      return
    }

    if (!messages.data.hasMessage(message.conversation_uuid, message.uuid)) {
      const echoId = message.echo_id
      if (echoId && messages.data.hasMessage(message.conversation_uuid, echoId)) {
        replacePendingMessage(message.conversation_uuid, echoId, {
          uuid: message.uuid,
          id: message.id,
          created_at: message.created_at
        })
        return
      }

      if (message.type === 'activity') {
        const activityMessage = {
          uuid: message.uuid,
          id: message.id,
          conversation_uuid: message.conversation_uuid,
          type: 'activity',
          content: message.preview,
          created_at: message.created_at,
          updated_at: message.created_at,
          sender_type: message.sender_type
        }
        messages.data.addMessage(message.conversation_uuid, activityMessage)
        incrementMessageVersion()
        setTimeout(() => {
          emitter.emit(EMITTER_EVENTS.NEW_MESSAGE, {
            conversation_uuid: message.conversation_uuid,
            message: activityMessage
          })
        }, 100)
        return
      }

      const fetchedMessage = await fetchMessage(message.conversation_uuid, message.uuid)
      if (fetchedMessage) {
        updateConversationLastMessage(message.conversation_uuid, fetchedMessage)
        setTimeout(() => {
          emitter.emit(EMITTER_EVENTS.NEW_MESSAGE, {
            conversation_uuid: message.conversation_uuid,
            message: fetchedMessage
          })
        }, 100)
      }
    }
  }

  let pendingMessageSeq = 0
  const outgoingStatusChecks = new WeakMap()

  async function checkOutgoingMessageStatus (conversationUUID, messageUUID) {
    const message = messages.data.getMessage(conversationUUID, messageUUID)
    if (message?.status !== 'pending' || message.status_check_timed_out || outgoingStatusChecks.has(message)) return

    const check = {}
    const isStillPending = () =>
      outgoingStatusChecks.get(message) === check &&
      messages.data.getMessage(conversationUUID, messageUUID) === message &&
      message.status === 'pending'
    outgoingStatusChecks.set(message, check)
    try {
      for (const delay of OUTGOING_STATUS_CHECK_DELAYS) {
        await new Promise(resolve => setTimeout(resolve, delay))
        if (!isStillPending()) return

        let confirmed
        const previousMeta = message.meta
        try {
          const response = await api.getConversationMessage(conversationUUID, messageUUID)
          confirmed = response?.data?.data
        } catch {
          // The send was already accepted. A status lookup failure can be retried silently.
        }
        if (!isStillPending()) return
        if (!confirmed?.status || confirmed.status === 'pending') continue

        mergeMessageUpdate({
          conversation_uuid: conversationUUID,
          uuid: messageUUID,
          status: confirmed.status,
          meta: message.meta === previousMeta ? confirmed.meta ?? message.meta : { ...confirmed.meta, ...message.meta }
        })
        return
      }

      if (isStillPending()) {
        messages.data.updateMessage(conversationUUID, messageUUID, { status_check_timed_out: true })
        incrementMessageVersion()
      }
    } finally {
      if (outgoingStatusChecks.get(message) === check) outgoingStatusChecks.delete(message)
    }
  }

  function addPendingMessage (conversationUUID, content, isPrivate, author, attachments = [], textContent = '', meta = {}) {
    const tempUUID = `pending-${Date.now()}-${++pendingMessageSeq}`
    const pendingMessage = {
      uuid: tempUUID,
      // Stays fixed when the server uuid replaces the temp one, so the bubble is not re-rendered.
      render_key: tempUUID,
      type: 'outgoing',
      status: 'pending',
      content,
      text_content: textContent,
      content_type: 'html',
      private: isPrivate,
      sender_type: 'agent',
      sender_id: author.id,
      conversation_uuid: conversationUUID,
      created_at: new Date().toISOString(),
      author,
      attachments: attachments.map(a => ({
        uuid: a.uuid,
        name: a.filename || a.name,
        size: a.size,
        content_type: a.content_type,
        url: a.url,
        disposition: a.disposition
      })),
      meta
    }
    messages.data.addMessage(conversationUUID, pendingMessage)
    incrementMessageVersion()
    setTimeout(() => {
      emitter.emit(EMITTER_EVENTS.NEW_MESSAGE, {
        conversation_uuid: conversationUUID,
        message: pendingMessage
      })
    }, 0)

    // Remove the temporary bubble if the server hasn't supplied a persisted UUID.
    const tempId = pendingMessage.uuid
    setTimeout(() => {
      if (messages.data.hasMessage(conversationUUID, tempId)) {
        messages.data.removeMessage(conversationUUID, tempId)
        incrementMessageVersion()
      }
    }, 10000)

    return pendingMessage.uuid
  }

  function replacePendingMessage (conversationUUID, tempUUID, realMessage) {
    const existing = messages.data.getMessage(conversationUUID, realMessage.uuid)
    if (existing) {
      messages.data.removeMessage(conversationUUID, tempUUID)
      // When the echo arrived first, keep any newer WebSocket status and metadata.
      if (existing.render_key === tempUUID && !existing.meta?.deleted_at) {
        const status = existing.status === 'pending' ? realMessage.status ?? existing.status : existing.status
        messages.data.updateMessage(conversationUUID, realMessage.uuid, {
          ...realMessage,
          status,
          meta: { ...realMessage.meta, ...existing.meta }
        })
      }
    } else if (messages.data.hasMessage(conversationUUID, tempUUID)) {
      messages.data.updateMessage(conversationUUID, tempUUID, realMessage)
    } else if (messages.data.hasConversation(conversationUUID) || conversation.data?.uuid === conversationUUID) {
      messages.data.addMessage(conversationUUID, realMessage)
    }
    incrementMessageVersion()
    checkOutgoingMessageStatus(conversationUUID, realMessage.uuid)
  }

  function removePendingMessage (conversationUUID, tempUUID) {
    messages.data.removeMessage(conversationUUID, tempUUID)
    incrementMessageVersion()
  }

  function addNewConversation (conversation) {
    if (!isConversationInList(conversation.uuid)) {
      refreshConversationList()
    }
  }

  function mergeMessageUpdate (data) {
    const { conversation_uuid, uuid, ...fields } = data
    if (fields.edited_at || fields.recalled_at) {
      if (messages.data.hasConversation(conversation_uuid) ||
          activeMessageLoad?.uuid === conversation_uuid ||
          conversation.data?.uuid === conversation_uuid) {
        if (messages.data.applyPublicMessageUpdate(conversation_uuid, data)) incrementMessageVersion()
      }
      return
    }
    const message = messages.data.getMessage(conversation_uuid, uuid)
    if (!message) return
    const statusChanged = fields.status && fields.status !== message.status
    if (statusChanged && message.status_check_timed_out) fields.status_check_timed_out = false
    messages.data.updateMessage(conversation_uuid, uuid, fields)
    incrementMessageVersion()
    if (statusChanged) {
      outgoingStatusChecks.delete(message)
      if (fields.status === 'pending' && message.type === 'outgoing' && !message.private) {
        checkOutgoingMessageStatus(conversation_uuid, uuid)
      }
    }
  }

  function canPushInsert (conv) {
    const matched = matchesAssignmentScope(conv)
    if (matched !== null) return matched
    return conversations.listType === CONVERSATION_LIST_TYPE.ALL
  }

  function isInCurrentList (conv) {
    return (conversations.status === '' || conv.status === conversations.status) && belongsToList(conv)
  }

  // Keeps the list total in step when a live update moves a loaded row into or out of the current list.
  function mergeLiveUpdate (uuid, payload) {
    const existing = conversations.data?.find(c => c.uuid === uuid)
    if (!existing) return null
    const wasListed = isInCurrentList(existing)
    deepMerge(existing, payload)
    const isListed = isInCurrentList(existing)
    if (wasListed !== isListed) {
      conversations.total = Math.max(0, conversations.total + (isListed ? 1 : -1))
    }
    return existing
  }

  function handleConvPush (payload) {
    if (!payload || !payload.uuid) return
    rememberAssignee(payload)
    if (mergeLiveUpdate(payload.uuid, payload)) {
      if (conversation.data?.uuid === payload.uuid) {
        deepMerge(conversation.data, payload)
      }
      return
    }
    if (!canPushInsert(payload)) return
    if (conversations.status !== '' && payload.status !== conversations.status) return
    if (!conversations.data) conversations.data = []
    conversations.data.unshift(payload)
    conversations.total += 1
    trimListToCurrentPage()
  }

  function mergeConversationUpdate (update) {
    if (conversation.data?.uuid === update.uuid) {
      deepMerge(conversation.data, update)
    }
    mergeLiveUpdate(update.uuid, update)
  }

  function mergeContactUpdate (update) {
    const { contact_id, ...fields } = update
    if (conversation.data?.contact_id === contact_id) {
      if (!conversation.data.contact) conversation.data.contact = {}
      deepMerge(conversation.data.contact, fields)
    }
    conversations?.data?.forEach(c => {
      if (c.contact_id === contact_id) {
        if (!c.contact) c.contact = {}
        deepMerge(c.contact, fields)
      }
    })
  }

  function resetConversations () {
    cancelListLoad()
    conversations.data = []
    conversations.page = 1
    conversations.initialized = false
    conversations.hasMore = false
    conversations.total = 0
    pendingNotificationUUIDs.clear()
    clearSelection()
  }

  function setMacro (macro, context) {
    macros.value[context] = macro
  }

  function setMacroActions (actions, context) {
    if (!macros.value[context]) {
      macros.value[context] = {}
    }
    macros.value[context].actions = actions
  }

  function getMacro (context) {
    return macros.value[context] || {}
  }

  function removeMacroAction (action, context) {
    if (!macros.value[context]) return
    macros.value[context].actions = macros.value[context].actions.filter(a => a.type !== action.type)
  }

  function resetMacro (context) {
    macros.value = { ...macros.value, [context]: {} }
  }

  function updateTypingStatus (typingData) {
    const { conversation_uuid: uuid, is_typing } = typingData

    if (conversation.data?.uuid === uuid) {
      if (typingTimeout) {
        clearTimeout(typingTimeout)
        typingTimeout = null
      }
      conversation.isTyping = is_typing
      if (is_typing) {
        typingTimeout = setTimeout(() => {
          conversation.isTyping = false
          typingTimeout = null
        }, TYPING_RECEIVE_TIMEOUT)
      }
    }

    const prev = typingTimeoutsByUUID.get(uuid)
    if (prev) clearTimeout(prev)
    if (is_typing) {
      typingByUUID[uuid] = true
      typingTimeoutsByUUID.set(uuid, setTimeout(() => {
        delete typingByUUID[uuid]
        typingTimeoutsByUUID.delete(uuid)
      }, TYPING_RECEIVE_TIMEOUT))
    } else {
      delete typingByUUID[uuid]
      typingTimeoutsByUUID.delete(uuid)
    }
  }

  function sendTyping (isTyping, otherAttributes = {}) {
    if (conversation.data?.uuid) {
      sendTypingIndicator(conversation.data.uuid, isTyping, otherAttributes.isPrivateMessage)
    }
  }

  function draftMapKey (uuid, type) {
    return `${uuid}::${type}`
  }

  async function fetchAllDrafts () {
    try {
      const resp = await api.getAllDrafts()
      const newDrafts = new Map()
      if (resp.data?.data) {
        for (const draft of resp.data.data) {
          newDrafts.set(draftMapKey(draft.conversation_uuid, draft.type), draft)
        }
      }
      drafts.value = newDrafts
    } catch (e) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(e).message
      })
    } finally {
      resolveDraftsReady()
    }
  }

  function getDraft (uuid, type) {
    return drafts.value.get(draftMapKey(uuid, type))
  }

  function setDraft (uuid, type, draft) {
    drafts.value.set(draftMapKey(uuid, type), draft)
    drafts.value = new Map(drafts.value)
  }

  function removeDraft (uuid, type) {
    drafts.value.delete(draftMapKey(uuid, type))
    drafts.value = new Map(drafts.value)
  }

  function hasDraft (uuid, type) {
    return drafts.value.has(draftMapKey(uuid, type))
  }

  function conversationHasDraft (uuid) {
    return hasDraft(uuid, 'reply') || hasDraft(uuid, 'private_note')
  }

  function setSelectedDraftType (uuid, type) {
    selectedDraftType.value.set(uuid, type)
    selectedDraftType.value = new Map(selectedDraftType.value)
  }

  function resolveDraftType (uuid) {
    const last = selectedDraftType.value.get(uuid)
    if (last && hasDraft(uuid, last)) return last
    if (hasDraft(uuid, 'reply')) return 'reply'
    if (hasDraft(uuid, 'private_note')) return 'private_note'
    return last || 'reply'
  }

  function conversationDraftPreview (uuid) {
    return getDraft(uuid, resolveDraftType(uuid))
  }


  function getMediaPreview (attachments) {
    if (!attachments?.length) return ''
    const contentType = attachments[0].content_type || ''
    const i18n = getI18n()
    const t = i18n?.global?.t || ((key) => key.split('.').pop())

    if (contentType.startsWith('image/')) return t('globals.terms.image')
    if (contentType.startsWith('video/')) return t('globals.terms.video')
    if (contentType.startsWith('audio/')) return t('globals.terms.audio')
    return t('globals.terms.file')
  }

  // On new conversation uuids, subscribere user to those conversations.
  watch(
    () => conversations.data?.map(c => c.uuid).sort().join(',') ?? '',
    () => subscribeListReplace(conversations.data?.map(c => c.uuid) || [])
  )

  return {
    macros,
    conversations,
    conversation,
    messages,
    conversationsList,
    conversationMessages,
    hasPendingMessages,
    currentConversationHasMoreMessages,
    isConversationOpen,
    current,
    currentContactName,
    currentTo,
    currentBCC,
    currentCC,
    currentFrom,
    currentFromOptions,
    isConversationInList,
    addPendingNotification,
    mergeConversationUpdate,
    handleConvPush,
    mergeContactUpdate,
    addNewConversation,
    fetchNextMessages,
    ensureLinkedMessage,
    fetchNextConversations,
    mergeMessageUpdate,
    updateAssigneeLastSeen,
    applyConversationRead,
    markAsUnread,
    incrementUnread,
    updateConversationMessage,
    snoozeConversation,
    fetchConversation,
    fetchConversationsList,
    fetchMessages,
    updateConversationTags,
    updateAssignee,
    updatePriority,
    updateStatus,
    refreshConversationList,
    refreshInboxAfterResume,
    resetConversations,
    updateConversationLastMessage,
    fetchFirstPageConversations,
    fetchStatuses,
    fetchPriorities,
    setListSortField,
    setListStatus,
    removeMacroAction,
    getMacro,
    setMacro,
    resetMacro,
    setMacroActions,
    removeAssignee,
    getListSortField,
    sortFieldI18nKeys,
    getListStatus,
    statuses,
    priorities,
    priorityOptions,
    statusOptionsNoSnooze,
    statusOptions,
    updateTypingStatus,
    typingByUUID,
    sendTyping,
    drafts,
    draftsReady,
    fetchAllDrafts,
    getDraft,
    setDraft,
    removeDraft,
    hasDraft,
    deleteMessage,
    editLiveChatMessage,
    recallLiveChatMessage,
    conversationHasDraft,
    conversationDraftPreview,
    getMediaPreview,
    setSelectedDraftType,
    resolveDraftType,
    addPendingMessage,
    replacePendingMessage,
    removePendingMessage,
    selectedUUIDs,
    selectedCount,
    allSelected,
    toggleSelect,
    selectAll,
    clearSelection,
    isSelected,
    sidebarCounts,
    fetchSidebarCounts,
    fetchViewCount,
    refreshSidebarCounts
  }
})
