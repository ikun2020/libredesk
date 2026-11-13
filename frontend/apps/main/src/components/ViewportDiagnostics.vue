<template>
  <aside
    v-if="active"
    class="viewport-diagnostics fixed z-[100] w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-background p-3 text-foreground shadow-lg"
    :aria-label="t('diagnostics.title')"
    data-testid="viewport-diagnostics"
  >
    <div class="flex items-center justify-between gap-2">
      <strong class="text-sm">{{ t('diagnostics.title') }}</strong>
      <Button type="button" variant="ghost" size="icon" class="h-8 w-8" :aria-label="t('diagnostics.stop')" @click="stop">
        <X class="size-4" aria-hidden="true" />
      </Button>
    </div>
    <p class="mt-1 text-xs text-muted-foreground">{{ t('diagnostics.instructions') }}</p>
    <p class="mt-2 text-xs text-muted-foreground">{{ t('diagnostics.privacy') }}</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <Button type="button" size="sm" @click="copyReport">{{ t('diagnostics.copy') }}</Button>
      <Button type="button" size="sm" variant="outline" @click="downloadReport">{{ t('diagnostics.download') }}</Button>
    </div>
    <p v-if="status" class="mt-2 text-xs" role="status">{{ t(status) }}</p>
  </aside>
</template>

<script setup>
import { onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { Button } from '@shared-ui/components/ui/button'
import { useAppSettingsStore } from '@main/stores/appSettings'
import { useViewportDiagnostics } from '@main/composables/useViewportDiagnostics'
import { createViewportRecorder } from '@main/utils/viewport-diagnostics'

const { t } = useI18n()
const { active, stop } = useViewportDiagnostics()
const settingsStore = useAppSettingsStore()
const status = ref('')
let recorder
let downloadUrl
let revokeTimer

const clearDownload = () => {
  window.clearTimeout(revokeTimer)
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = undefined
}

watch(active, enabled => {
  recorder?.stop()
  recorder = undefined
  clearDownload()
  status.value = ''
  if (enabled) {
    recorder = createViewportRecorder({ version: settingsStore.settings['app.version'] || '' })
    recorder.start()
  }
}, { immediate: true })

const report = () => {
  recorder.capture('export')
  return recorder.exportReport()
}

const copyReport = async () => {
  const current = recorder
  const text = report()
  try {
    // Call directly from the click so Safari keeps transient user activation.
    await navigator.clipboard.writeText(text)
    if (recorder === current) status.value = 'diagnostics.copied'
  } catch {
    if (recorder === current) status.value = 'diagnostics.copyFailed'
  }
}

const downloadReport = () => {
  clearDownload()
  downloadUrl = URL.createObjectURL(new Blob([report()], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = 'libredesk-layout-diagnostics.json'
  link.click()
  // Keep the URL valid while Safari handles the download/share sheet.
  revokeTimer = window.setTimeout(clearDownload, 60000)
}

onUnmounted(() => {
  recorder?.stop()
  clearDownload()
  stop()
})
</script>

<style scoped>
.viewport-diagnostics {
  top: max(0.5rem, env(safe-area-inset-top));
  right: max(0.5rem, env(safe-area-inset-right));
}
</style>
