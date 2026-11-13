import { computed } from 'vue'
import { useAppSettingsStore } from '@main/stores/appSettings'
import {
  formatDate,
  formatTime,
  formatFullTimestamp,
  formatMessageTimestamp,
  isSameDayInTimeZone
} from '@shared-ui/utils/datetime.js'

// Read the setting when formatting so mounted conversations update after a
// settings fetch/save, without depending on the agent's browser time zone.
export function useWorkspaceDateTime () {
  const settingsStore = useAppSettingsStore()
  const timeZone = computed(() => settingsStore.settings['app.timezone'] || 'UTC')

  return {
    formatDate: time => formatDate(time, timeZone.value),
    formatTime: time => formatTime(time, timeZone.value),
    formatFullTimestamp: time => formatFullTimestamp(time, timeZone.value),
    formatMessageTimestamp: time => formatMessageTimestamp(time, timeZone.value),
    isSameDay: (first, second) => isSameDayInTimeZone(first, second, timeZone.value)
  }
}
