import axios from 'axios'
import { createVisitorProfileSync } from '../utils/visitorProfile.js'

let _sessionToken = ''
let _visitorToken = ''
let _pendingSupportSyncIdentity = ''

export function usesVisitorProfileIntegration() {
  return new URLSearchParams(window.location.search).get('integration') === 'lite'
}

const visitorProfileSync = createVisitorProfileSync({
  getToken: () => _sessionToken,
  canSync: () => usesVisitorProfileIntegration() && _stores?.userStore.isVisitor === true,
  send: (profile, token, signal) => http.post('/api/v1/widget/chat/visitor/profile', profile, {
    widgetSessionToken: token, signal
  })
})
export const clearVisitorProfile = () => visitorProfileSync.clear()
export const flushVisitorProfile = () => visitorProfileSync.flush()
export const setVisitorProfile = (profile) => usesVisitorProfileIntegration() && visitorProfileSync.set(profile)

function postToParent(data) {
  if (!window.parent || window.parent === window) return
  const target = new URLSearchParams(window.location.search).get('parent_origin')
  if (!target || target === 'null') return
  window.parent.postMessage(data, target)
}

function getInboxIDFromQuery() {
  const params = new URLSearchParams(window.location.search)
  return params.get('inbox_id') || null
}

export function setApiSessionToken(token) {
  _sessionToken = token || ''
  _pendingSupportSyncIdentity = ''
}

export function setPendingSupportSyncIdentity(token) {
  _pendingSupportSyncIdentity = token
}

export function hasPendingSupportSyncIdentity() {
  return !!_pendingSupportSyncIdentity
}

export function setVisitorToken(token) {
  _visitorToken = token
  postToParent({ type: 'STORE_VISITOR_TOKEN', token })
}

export function clearVisitorToken() {
  _visitorToken = ''
  postToParent({ type: 'CLEAR_VISITOR_TOKEN' })
}

export function getVisitorToken() {
  return _visitorToken || null
}

export function initVisitorToken(token) {
  _visitorToken = token || ''
}

// Stores registered by App.vue for use in the response interceptor.
let _stores = null
export function registerStores(stores) {
  _stores = stores
}

// Clears all session state, cookies, and closes widget on 401/session expiry.
function handleSessionExpired() {
  if (!_stores) return
  const { userStore, chatStore, widgetStore } = _stores
  userStore.clearSessionToken()
  clearVisitorToken()
  postToParent({ type: 'CLEAR_SESSION_TOKEN' })
  chatStore.setCurrentConversation(null)
  chatStore.conversations = null
  widgetStore.closeWidget()
}

// Saves session token and user metadata from a server response.
// When isNewVisitor is true, also stores the token as the visitor token (for merge flow).
export function saveSession(sessionToken, user, userStore, isNewVisitor = false) {
  userStore.setSessionToken(sessionToken)
  setApiSessionToken(sessionToken)
  if (user) userStore.setUserMeta(user)
  if (isNewVisitor) setVisitorToken(sessionToken)
  postToParent({ type: 'STORE_SESSION', token: sessionToken })
  void flushVisitorProfile()
}

// Verified Support Sync sessions stay in the iframe, including when the first
// message turns a pending identity into a contact.
export function saveSupportSyncSession(sessionToken, user, userStore) {
  userStore.setSessionToken(sessionToken)
  setApiSessionToken(sessionToken)
  userStore.setUserMeta(user, 'support-sync')
}

// A profile refresh can restore this same signed account while its first
// message is being sent. Preserve the response if it belongs to that account.
export function matchesChatInitSession(userStore, sourceSessionToken, response) {
  return userStore.userSessionToken === sourceSessionToken ||
    (!sourceSessionToken && response.identity_provider === 'support-sync' &&
      response.user?.user_id > 0 && response.user.user_id === userStore.userID)
}

// Returns visitor token if current user is a verified contact (for merge).
function getVisitorTokenForMerge() {
  if (usesVisitorProfileIntegration()) return null
  const vt = getVisitorToken()
  if (!vt || !_sessionToken || vt === _sessionToken) {
    return null
  }
  return vt
}

const http = axios.create({
  timeout: 10000,
  responseType: 'json'
})

const pendingIdentityHeader = 'X-Libredesk-Pending-Identity'
const chatAPI = '/api/v1/widget/chat/'
const permitsPendingIdentity = path =>
  path === chatAPI + 'conversations/init' ||
  path === chatAPI + 'help' ||
  path.startsWith(chatAPI + 'help/') ||
  path === chatAPI + 'campaigns/next' ||
  path === chatAPI + 'campaigns/event'

// Set content type and authentication headers
http.interceptors.request.use((request) => {
  if ((request.method === 'post' || request.method === 'put') && !request.headers['Content-Type']) {
    request.headers['Content-Type'] = 'application/json'
  }

  if (request.url && request.url.includes('/api/v1/widget/')) {
    const inboxId = getInboxIDFromQuery()

    const sessionToken = request.widgetSessionToken ?? _sessionToken
    if (sessionToken) {
      request.headers['Authorization'] = `Bearer ${sessionToken}`
    } else if (_pendingSupportSyncIdentity && permitsPendingIdentity(request.url)) {
      request.headers[pendingIdentityHeader] = _pendingSupportSyncIdentity
    }

    if (inboxId) {
      request.headers['X-Libredesk-Inbox-ID'] = inboxId.toString()
    }

    const visitorTokenForMerge = getVisitorTokenForMerge()
    if (visitorTokenForMerge) {
      request.headers['X-Libredesk-Visitor-Token'] = visitorTokenForMerge
    }
  }

  return request
})

http.interceptors.response.use(
  (response) => {
    if (response.headers['x-libredesk-clear-visitor']) {
      clearVisitorToken()
    }
    return response
  },
  (error) => {
    if (error.response?.status === 401) {
      // Ignore a stale 401 when a newer session is already active.
      const reqAuth = error.config?.headers?.Authorization
      const pending = error.config?.headers?.[pendingIdentityHeader]
      if ((reqAuth && reqAuth === `Bearer ${_sessionToken}`) ||
          (pending && pending === _pendingSupportSyncIdentity)) {
        handleSessionExpired()
      }
    }
    // Consumers may log this error. Never expose identity/session credentials in
    // Axios' attached config or serialized request body.
    if (error.config) {
      if (error.config.headers) {
        delete error.config.headers.Authorization
        delete error.config.headers['X-Libredesk-Visitor-Token']
        delete error.config.headers[pendingIdentityHeader]
      }
      if (error.config.url?.includes('/chat/auth/exchange')) error.config.data = '[redacted]'
      if (error.config.url?.includes('/chat/visitor/profile') || usesVisitorProfileIntegration()) error.config.data = '[redacted]'
      delete error.config.widgetSessionToken
    }
    return Promise.reject(error)
  }
)

const getWidgetSettings = (inboxID) =>
  http.get('/api/v1/widget/chat/settings', {
    params: { inbox_id: inboxID }
  })
const getLanguage = (lang) => http.get(`/api/v1/lang/${lang}`)
const getAvailableLanguages = () => http.get('/api/v1/lang')
const exchangeJWTForSession = (jwt, visitorToken) => http.post('/api/v1/widget/chat/auth/exchange',
  visitorToken ? { jwt, visitor_token: visitorToken } : { jwt })
const getAuthMe = () => http.get('/api/v1/widget/chat/auth/me')
const initChatConversation = (data, files = []) => {
  if (usesVisitorProfileIntegration() && !data.delivery_id && (!_sessionToken || _stores?.userStore.isVisitor === true)) {
    const profile = visitorProfileSync.get()
    if (profile) data = { ...data, visitor_profile: profile }
  }
  if (!files.length) return http.post('/api/v1/widget/chat/conversations/init', data)

  const formData = new FormData()
  formData.append('payload', JSON.stringify(data))
  for (const file of files) formData.append('files', file)
  return http.post('/api/v1/widget/chat/conversations/init', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  })
}
const getChatConversations = () => http.get('/api/v1/widget/chat/conversations')
const getChatConversation = (uuid) => http.get(`/api/v1/widget/chat/conversations/${uuid}`)
const downloadTranscript = (uuid) =>
  http.get(`/api/v1/widget/chat/conversations/${uuid}/transcript`, { responseType: 'blob' })
const getHelp = (locale, fallbackLocale) =>
  http.get('/api/v1/widget/chat/help', {
    params: { locale, fallback_locale: fallbackLocale !== locale ? fallbackLocale : undefined }
  })
const searchHelp = (q, locale) =>
  http.get('/api/v1/widget/chat/help/search', { params: { q, locale } })
const getHelpArticle = (slug, locale) =>
  http.get(`/api/v1/widget/chat/help/articles/${encodeURIComponent(slug)}`, { params: { locale } })
const sendChatMessage = (uuid, data) =>
  http.post(`/api/v1/widget/chat/conversations/${uuid}/message`, data)
const submitHandoffForm = (uuid, formData) =>
  http.post(`/api/v1/widget/chat/conversations/${uuid}/handoff-form`, { form_data: formData })
const closeChatConversation = (uuid) => http.post(`/api/v1/widget/chat/conversations/${uuid}/close`)
const uploadMedia = (conversationUUID, files) => {
  const formData = new FormData()
  formData.append('conversation_uuid', conversationUUID)
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i])
  }
  return http.post('/api/v1/widget/media/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  })
}
const updateConversationLastSeen = (uuid) =>
  http.post(`/api/v1/widget/chat/conversations/${uuid}/update-last-seen`)
const submitCSATResponse = (csatUuid, rating, feedback) =>
  http.post(`/api/v1/csat/${csatUuid}/response`, {
    rating,
    feedback
  })

const nextCampaign = (data) => http.post('/api/v1/widget/chat/campaigns/next', data)
const campaignEvent = (data) => http.post('/api/v1/widget/chat/campaigns/event', data)

export default {
  nextCampaign,
  campaignEvent,
  getWidgetSettings,
  getLanguage,
  getAvailableLanguages,
  exchangeJWTForSession,
  getAuthMe,
  initChatConversation,
  getChatConversations,
  getChatConversation,
  downloadTranscript,
  getHelp,
  searchHelp,
  getHelpArticle,
  sendChatMessage,
  submitHandoffForm,
  closeChatConversation,
  uploadMedia,
  updateConversationLastSeen,
  submitCSATResponse
}
