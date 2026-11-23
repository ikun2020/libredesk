<template>
  <div
    class="libredesk-widget-app text-foreground bg-background"
    :class="{ dark: widgetStore.isDark, mobile: widgetStore.isMobileFullScreen }"
    :style="customColorStyle"
    @click.once="initAudioContext"
    @touchstart.once="initAudioContext"
  >
    <div class="widget-container">
      <MainLayout />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, watch, getCurrentInstance } from 'vue'
import { useWidgetStore } from './store/widget.js'
import { useChatStore } from '@widget/store/chat.js'
import { useUserStore } from './store/user.js'
import { initWidgetWS, closeWidgetWebSocket, sendPageVisit, skipInitialWsSync } from './websocket.js'
import api, { setApiSessionToken, initVisitorToken, saveSession, registerStores,
  usesVisitorProfileIntegration, setVisitorProfile, clearVisitorProfile, flushVisitorProfile,
  hasPendingSupportSyncIdentity, setPendingSupportSyncIdentity, saveSupportSyncSession } from '@widget/api/index.js'
import { useUnreadCount } from './composables/useUnreadCount.js'
import { initAudioContext } from '@shared-ui/composables/useNotificationSound.js'
import { hexToHSL, getContrastingHSL } from '@shared-ui/utils/color.js'
import MainLayout from '@widget/layouts/MainLayout.vue'
import { useHelpStore } from '@widget/store/help.js'
import { useI18n } from 'vue-i18n'
import { useProactiveStore } from '@widget/store/proactive.js'
import { useReplyPreviews } from '@widget/composables/useReplyPreviews.js'
import { resolveLanguage } from '@widget/utils/language.js'

const widgetStore = useWidgetStore()
const chatStore = useChatStore()
const userStore = useUserStore()
const help = useHelpStore()
const proactive = useProactiveStore()
const { locale, setLocaleMessage } = useI18n()
useReplyPreviews()

// Register stores for the global 401 response interceptor.
registerStores({ userStore, chatStore, widgetStore })

// Initialize unread count tracking and sending to parent window.
useUnreadCount()

const globals = getCurrentInstance().appContext.config.globalProperties
const widgetConfig = globals.$widgetConfig
help.requestedLocale = globals.$widgetLanguagePreference || locale.value
help.fallbackLocale = locale.value
if (widgetConfig) {
  widgetStore.updateConfig(widgetConfig)
}

const customColorStyle = computed(() => {
  const style = {}
  const colors = widgetStore.branding?.colors
  if (colors?.primary) {
    style['--primary'] = hexToHSL(colors.primary)
    style['--primary-foreground'] = getContrastingHSL(colors.primary)
  }
  return style
})

// Dropdowns and dialogs portal to document.body, outside the app wrapper.
watch(
  () => widgetStore.isDark,
  (dark) => document.documentElement.classList.toggle('dark', dark),
  { immediate: true }
)

onMounted(() => {
  setupParentMessageListeners()
  window.parent.postMessage({ type: 'VUE_APP_READY', visitorProfileProtocol: 1, supportSyncIdentityProtocol: 1 }, '*')
})

const signalWidgetLoaded = () => {
  window.parent.postMessage(
    {
      type: 'WIDGET_LOADED',
      campaigns: widgetStore.config.has_campaigns,
      campaignDelay: widgetStore.config.campaign_delay_seconds || 0
    },
    '*'
  )
  if (widgetStore.config.help?.help_center_id) void help.load()
}

const fetchInitialConversations = async () => {
  const success = await chatStore.fetchConversations()
  if (!success) return false
  const ongoing = chatStore.supportSyncConversation
  let loaded = false
  if (chatStore.hasConversations) {
    try {
      loaded = await chatStore.loadConversation((ongoing ?? chatStore.getConversations[0]).uuid)
    } catch { /* non-blocking */ }
  }
  const audience = userStore.isVisitor ? widgetStore.config?.visitors : widgetStore.config?.users
  const directToConversation =
    audience?.direct_to_conversation ?? widgetStore.config?.direct_to_conversation
  if (ongoing ? loaded : directToConversation) {
    widgetStore.navigateToChat()
  }
  return true
}

let languageRequest = 0
const setLanguage = async (requested) => {
  if (widgetStore.config.language !== 'auto') return
  const request = ++languageRequest
  try {
    const available = await api.getAvailableLanguages()
    const availableCodes = available.data.data.map((l) => l.code)
    const browserLanguages = [navigator.language || navigator.languages?.[0] || '']
    const language = resolveLanguage(widgetStore.config, requested, browserLanguages, availableCodes)
    if (request !== languageRequest) return
    if (language.locale === locale.value && language.requestedLocale === help.requestedLocale) return
    if (language.locale !== locale.value) {
      const messages = await api.getLanguage(language.locale)
      if (request !== languageRequest) return
      setLocaleMessage(language.locale, messages.data)
      locale.value = language.locale
    }
    help.requestedLocale = language.requestedLocale
    help.fallbackLocale = language.locale
    if (widgetStore.config.help?.help_center_id) {
      if (widgetStore.currentView === 'help' && widgetStore.isExpanded) {
        widgetStore.collapseWidget()
      }
      help.reset()
      await help.load()
    }
  } catch (error) {
    console.error('Error switching widget language:', error)
  }
}

// Listen for messages from parent window (widget.js)
let identityRequest = 0

const exchangeSupportSyncIdentity = async (message, parentOrigin) => {
  const refresh = message.type === 'SUPPORT_SYNC_PROFILE'
  const wasPending = hasPendingSupportSyncIdentity()
  if (refresh && !wasPending && (!userStore.userID || !userStore.userSessionToken || userStore.isVisitor)) return
  const request = ++identityRequest
  try {
    const response = await api.exchangeJWTForSession(message.jwt, refresh ? undefined : message.visitorToken)
    if (request !== identityRequest) return
    const { identity_provider, session_token, pending_identity, user } = response.data.data
    const pending = typeof pending_identity === 'string' && pending_identity !== ''
    const currentUser = userStore.userID
    if (identity_provider !== 'support-sync' || user?.is_visitor !== false ||
      (pending ? session_token || (refresh && !wasPending) :
        !session_token || !user.user_id || (refresh && currentUser && user.user_id !== currentUser))) {
      throw new Error('Invalid Support Sync identity')
    }

    if (!refresh) {
      clearVisitorProfile()
      initVisitorToken(response.headers?.['x-libredesk-clear-visitor'] ? '' : message.visitorToken || '')
      chatStore.conversations = null
    }
    const restoreHistory = !refresh || (!pending && !userStore.userSessionToken)
    if (pending) {
      // A refresh may complete just after the first send installs a verified
      // session. In that case the pending response is already out of date.
      if (!refresh || !userStore.userSessionToken) {
        if (!refresh) {
          userStore.clearSessionToken()
          chatStore.setCurrentConversation(null)
        }
        setPendingSupportSyncIdentity(pending_identity)
        userStore.setUserMeta(user, identity_provider)
      }
    } else {
      if (restoreHistory) skipInitialWsSync()
      saveSupportSyncSession(session_token, user, userStore)
    }
    if (restoreHistory) {
      if (!await fetchInitialConversations()) throw new Error('Support Sync history unavailable')
      if (request !== identityRequest) return
      signalWidgetLoaded()
    }
    if (request === identityRequest) window.parent.postMessage({ type: 'SUPPORT_SYNC_RESULT', ok: true }, parentOrigin)
  } catch {
    if (request !== identityRequest) return
    if (!refresh) {
      userStore.clearSessionToken()
      initVisitorToken('')
    }
    window.parent.postMessage({ type: 'SUPPORT_SYNC_RESULT', ok: false }, parentOrigin)
  }
}

const setupParentMessageListeners = () => {
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return
    const params = new URLSearchParams(window.location.search)
    const parentOrigin = params.get('parent_origin')
    if (parentOrigin && event.origin !== parentOrigin) return
    if (event.data.campaignSessionKey) proactive.setSessionKey(event.data.campaignSessionKey)
    if (event.data.campaignBrowserKey) proactive.setBrowserKey(event.data.campaignBrowserKey)
    if (event.data.type == 'WIDGET_CLOSED') {
      widgetStore.setOpen(false)
    } else if (event.data.type === 'WIDGET_OPENED') {
      widgetStore.setOpen(true)
    } else if (event.data.type === 'SET_MOBILE_STATE') {
      widgetStore.setMobileFullScreen(event.data.isMobile)
    } else if (event.data.type === 'WIDGET_EXPANDED') {
      widgetStore.setExpanded(event.data.isExpanded)
    } else if (event.data.type === 'SET_VISITOR_PROFILE') {
      // Lite profiles are reference data for the current random visitor only.
      if (parentOrigin && usesVisitorProfileIntegration()) setVisitorProfile(event.data.profile)
    } else if (event.data.type === 'SESSION_DATA') {
      if (event.data.visitorToken) {
        initVisitorToken(event.data.visitorToken)
      }
      const sessionToken = event.data.sessionToken
      try {
        if (sessionToken) {
          userStore.setSessionToken(sessionToken)
          setApiSessionToken(sessionToken)
          // Session exists, fetchInitialConversations will load data. Skip WS sync.
          skipInitialWsSync()
          // Fetch user metadata for returning visitors.
          // Guard against stale response if SET_JWT_TOKEN exchange replaced the token.
          try {
            const meResp = await api.getAuthMe()
            if (userStore.userSessionToken === sessionToken) {
              userStore.setUserMeta(meResp.data.data)
              void flushVisitorProfile()
            }
          } catch {
            // 401 is handled by the global response interceptor.
          }
        }
        await fetchInitialConversations()
      } finally {
        signalWidgetLoaded()
      }
    } else if (event.data.type === 'SET_LANGUAGE') {
      await setLanguage(event.data.language)
    } else if (event.data.type === 'SUPPORT_SYNC_AUTH' || event.data.type === 'SUPPORT_SYNC_PROFILE') {
      if (parentOrigin && params.get('integration') === 'support-sync') {
        await exchangeSupportSyncIdentity(event.data, parentOrigin)
      }
    } else if (event.data.type === 'SET_JWT_TOKEN') {
      const request = ++identityRequest
      clearVisitorProfile()
      if (event.data.visitorToken) {
        initVisitorToken(event.data.visitorToken)
      }
      if (event.data.jwt) {
        proactive.reset()
        help.reset()
        if (widgetStore.currentView === 'help') widgetStore.navigateToHome()
        chatStore.drafts = {}
        chatStore.preChatDraft = {}
        chatStore.handoffDraft = {}
        chatStore.conversations = null
        chatStore.setCurrentConversation(null)
        try {
          const resp = await api.exchangeJWTForSession(event.data.jwt)
          if (request !== identityRequest) return
          const { session_token, user } = resp.data.data
          saveSession(session_token, user, userStore)
          // Session exists, fetchInitialConversations will load data. Skip WS sync.
          skipInitialWsSync()
          chatStore.conversations = null
          await fetchInitialConversations()
          if (request === identityRequest) signalWidgetLoaded()
        } catch {
          // Axios errors can include the signed identity in config.data.
          console.error('Failed to exchange JWT for session')
          if (request !== identityRequest) return
          signalWidgetLoaded()
        }
      }
    } else if (event.data.type === 'CLEAR_SESSION') {
      identityRequest++
      clearVisitorProfile()
      proactive.reset()
      chatStore.drafts = {}
      chatStore.preChatDraft = {}
      chatStore.handoffDraft = {}
      userStore.clearSessionToken()
      chatStore.conversations = null
      chatStore.setCurrentConversation(null)
      help.reset()
      widgetStore.navigateToHome()
      signalWidgetLoaded()
    } else if (event.data.type === 'CAMPAIGN_CONTEXT') {
      await proactive.next(event.data.context, event.data.pageGeneration)
    } else if (event.data.type === 'CAMPAIGN_EVENT') {
      await proactive.event(event.data.event, event.data.id)
    } else if (event.data.type === 'PAGE_VISIT') {
      sendPageVisit(event.data.url, event.data.title)
    } else if (event.data.type === 'OPEN_CONVERSATION') {
      if (!chatStore.getConversations.some(conversation => conversation.uuid === event.data.uuid)) return
      widgetStore.navigateToMessages()
      if (await chatStore.loadConversation(event.data.uuid, true)) {
        const seen = new Date(chatStore.currentConversation.contact_last_seen_at)
        chatStore.previewUnreadUUID = chatStore.getCurrentConversationMessages.find(message => ['agent', 'ai_assistant'].includes(message.author?.type) && new Date(message.created_at) > seen)?.uuid || null
        widgetStore.navigateToChat()
      }
    }
  })
}

const initializeWebSocket = () => {
  const token = userStore.userSessionToken
  if (token) {
    const urlParams = new URLSearchParams(window.location.search)
    const inboxId = urlParams.get('inbox_id')
    if (inboxId) {
      initWidgetWS(token, inboxId)
    } else {
      console.error('Cannot initialize WebSocket: missing `inbox_id`')
    }
  } else {
    closeWidgetWebSocket()
  }
}

watch(
  () => userStore.userSessionToken,
  (newToken) => {
    if (newToken) {
      initializeWebSocket()
    } else {
      closeWidgetWebSocket()
    }
  }
)
</script>

<style scoped>
.libredesk-widget-app {
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
}

.widget-container {
  width: 100%;
  height: 100%;
}

/* iOS Safari auto-zooms on focus when font-size < 16px. Force 16px on mobile to prevent it. */
.mobile :deep(input),
.mobile :deep(textarea),
.mobile :deep(select) {
  font-size: 16px;
}
</style>
