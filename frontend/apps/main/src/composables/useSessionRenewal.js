import { onBeforeUnmount } from 'vue'
import { useEventListener } from '@vueuse/core'
import api from '@main/api'
import { useUserStore } from '@main/stores/user'

const DEFAULT_RENEW_AFTER_MS = 60_000
const RETRY_DELAY_MS = 1_000

export function useSessionRenewal () {
  const userStore = useUserStore()
  let nextAttempt = 0
  let pending = null
  let stopped = false

  const renewOnActivity = async (event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible' || !userStore.userID ||
        stopped || pending || Date.now() < nextAttempt) return

    pending = new AbortController()
    try {
      const response = await api.renewSession(pending.signal)
      const interval = response.data?.data?.renew_after_ms
      const cooldown = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RENEW_AFTER_MS
      nextAttempt = Date.now() + cooldown
    } catch (error) {
      if (error?.response?.status === 401) stopped = true
      nextAttempt = Date.now() + RETRY_DELAY_MS
    } finally {
      pending = null
    }
  }

  useEventListener(window, ['pointerdown', 'keydown', 'wheel'], renewOnActivity, {
    capture: true,
    passive: true
  })
  onBeforeUnmount(() => {
    stopped = true
    pending?.abort()
  })
}
