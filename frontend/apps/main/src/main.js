import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { initI18n } from './i18n'
import { useAppSettingsStore } from './stores/appSettings'
import router, { updatePageTitle } from './router'
import mitt from 'mitt'
import api from './api'
import '@shared-ui/assets/styles/main.scss'
import '@shared-ui/utils/string.js'
import Root from './Root.vue'

const setFavicon = (url) => {
  let link = document.createElement("link")
  link.rel = "icon"
  document.head.appendChild(link)
  link.href = url
}

async function loadAppSettings (settingsStore) {
  const settingsRequest = settingsStore.fetchSettings('general')
  const config = (await api.getConfig()).data.data
  settingsStore.setPublicConfig(config)
  const lang = config['app.lang'] || 'en-US'
  const [langMessages] = await Promise.all([api.getLanguage(lang), settingsRequest])

  // Set favicon.
  if (config['app.favicon_url'])
    setFavicon(config['app.favicon_url'])

  return initI18n({
    legacy: false,
    locale: lang,
    fallbackLocale: 'en-US',
    messages: {
      [lang]: langMessages.data
    }
  })
}

async function initApp () {
  const pinia = createPinia()
  const app = createApp(Root)
  app.use(pinia)
  app.config.globalProperties.emitter = mitt()
  const settingsRequest = loadAppSettings(useAppSettingsStore(pinia))

  // Start loading the first route alongside the settings and language.
  app.use(router)
  const [i18n] = await Promise.all([settingsRequest, router.isReady()])
  app.use(i18n)
  updatePageTitle(router.currentRoute.value)
  app.mount('#app')
  document.getElementById('app-startup')?.remove()
}

initApp().catch((error) => {
  document.getElementById('app-startup')?.setAttribute('data-startup-error', '')
  console.error('Error initializing app: ', error)
})
