import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { useThrottleFn } from '@vueuse/core'
import { handleHTTPError } from '@shared-ui/utils/http.js'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents'
import { updateAppBadge } from '@main/utils/appBadge'
import api from '@main/api'

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref([])
  const unreadCount = ref(0)
  const totalCount = ref(0)
  const isLoading = ref(false)
  const hasMore = ref(true)
  const emitter = useEmitter()
  let statsRequest = 0
  let notificationsRequest = 0
  let requestedEnd = 0

  const hasUnread = computed(() => unreadCount.value > 0)
  watch(hasUnread, (value) => updateAppBadge(value))

  const unreadNotifications = computed(() =>
    notifications.value.filter(n => !n.is_read)
  )

  const readNotifications = computed(() =>
    notifications.value.filter(n => n.is_read)
  )

  // Fetch notifications with pagination
  const fetchNotifications = async (limit = 30, offset = 0, append = false, { silent = false } = {}) => {
    const request = ++notificationsRequest
    requestedEnd = offset + limit
    isLoading.value = true
    try {
      const data = []
      while (data.length < limit) {
        const pageLimit = Math.min(100, limit - data.length)
        const response = await api.getNotifications({ limit: pageLimit, offset: offset + data.length })
        if (request !== notificationsRequest) return
        const page = response?.data?.data || []
        data.push(...page)
        if (page.length < pageLimit) break
      }

      if (append) {
        notifications.value = [...notifications.value, ...data]
      } else {
        notifications.value = data
      }

      hasMore.value = data.length === limit
    } catch (error) {
      if (request !== notificationsRequest || silent) return
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    } finally {
      if (request === notificationsRequest) isLoading.value = false
    }
  }

  // Fetch notification stats (unread count)
  const fetchStats = async () => {
    const request = ++statsRequest
    try {
      const response = await api.getNotificationStats()
      const stats = response?.data?.data
      if (stats && request === statsRequest) {
        const count = stats.unread_count || 0
        // The service worker can set a badge even if the local count is already zero.
        if ((count > 0) === hasUnread.value) updateAppBadge(hasUnread.value)
        unreadCount.value = count
        totalCount.value = stats.total_count || 0
      }
    } catch {
      // pass
    }
  }

  // Mark single notification as read
  const markAsRead = async (id) => {
    try {
      await api.markNotificationAsRead(id)
      const notification = notifications.value.find(n => n.id === id)
      if (notification && !notification.is_read) {
        notification.is_read = true
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  const markAssignmentAsReadForConversation = (conversationUUID) => {
    if (!conversationUUID) return

    let markedCount = 0
    notifications.value.forEach(n => {
      if (
        !n.is_read &&
        n.notification_type === 'assignment' &&
        n.conversation_uuid === conversationUUID
      ) {
        n.is_read = true
        markedCount++
      }
    })

    if (markedCount > 0) {
      unreadCount.value = Math.max(0, unreadCount.value - markedCount)
    }
  }

  const refresh = (reloadList, options) => {
    const stats = fetchStats()
    if (!reloadList) return stats

    const pendingEnd = isLoading.value ? requestedEnd : 0
    const limit = Math.max(30, notifications.value.length, pendingEnd)
    return Promise.all([stats, fetchNotifications(limit, 0, false, options)])
  }

  const refreshConversationRead = (uuid) =>
    refresh(isLoading.value || notifications.value.some(n => !n.is_read && n.conversation_uuid === uuid))

  // An alert can arrive after the conversation read, or already be included in a stats response.
  const refreshNewNotification = () => refresh(notificationsRequest > 0)
  // Focus, visibility, and socket reconnection can fire together after resuming.
  const refreshAfterResume = useThrottleFn(() => refresh(notificationsRequest > 0, { silent: true }), 500)

  // Mark all notifications as read
  const markAllAsRead = async () => {
    try {
      await api.markAllNotificationsAsRead()
      notifications.value.forEach(n => {
        n.is_read = true
      })
      unreadCount.value = 0
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  // Delete single notification
  const deleteNotification = async (id) => {
    try {
      await api.deleteNotification(id)
      const index = notifications.value.findIndex(n => n.id === id)
      if (index !== -1) {
        const notification = notifications.value[index]
        if (!notification.is_read) {
          unreadCount.value = Math.max(0, unreadCount.value - 1)
        }
        totalCount.value = Math.max(0, totalCount.value - 1)
        notifications.value.splice(index, 1)
      }
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  // Delete all notifications
  const deleteAll = async () => {
    try {
      await api.deleteAllNotifications()
      notifications.value = []
      unreadCount.value = 0
      totalCount.value = 0
    } catch (error) {
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: handleHTTPError(error).message
      })
    }
  }

  // Load more notifications (for infinite scroll / load more button)
  const loadMore = async () => {
    if (!hasMore.value || isLoading.value) return
    await fetchNotifications(30, notifications.value.length, true)
  }

  return {
    notifications,
    unreadCount,
    totalCount,
    isLoading,
    hasMore,
    unreadNotifications,
    readNotifications,
    fetchNotifications,
    fetchStats,
    markAsRead,
    refreshConversationRead,
    refreshNewNotification,
    refreshAfterResume,
    markAssignmentAsReadForConversation,
    markAllAsRead,
    deleteNotification,
    deleteAll,
    loadMore
  }
})
