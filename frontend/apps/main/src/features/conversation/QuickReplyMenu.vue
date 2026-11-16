<template>
  <DropdownMenu :open="open" @update:open="setOpen">
    <DropdownMenuTrigger as-child :disabled="disabled">
      <Button type="button" variant="outline" size="sm" class="shrink-0 max-md:min-h-11">
        {{ t('replyBox.quickSend') }}
        <ChevronDown class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="end"
      :avoid-collisions="false"
      :collision-padding="8"
      class="w-64 max-w-[--radix-dropdown-menu-content-available-width]"
    >
      <DropdownMenuLabel v-if="status" class="font-normal text-muted-foreground">
        {{ status }}
      </DropdownMenuLabel>
      <DropdownMenuItem
        v-for="reply in replies"
        :key="reply.id"
        :disabled="disabled || selecting"
        class="max-md:min-h-11"
        @select.prevent="selectReply(reply.id)"
      >
        <span class="truncate" :title="reply.name">{{ reply.name }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import api from '@main/api'
import { Button } from '@shared-ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@shared-ui/components/ui/dropdown-menu'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents'
import { handleHTTPError } from '@shared-ui/utils/http'

const props = defineProps({ disabled: Boolean })
const emit = defineEmits(['insert'])
const { t } = useI18n()
const emitter = useEmitter()
const open = ref(false)
const replies = ref([])
const status = ref('')
const selecting = ref(false)
let requestVersion = 0

const setOpen = async (value) => {
  const version = ++requestVersion
  open.value = value
  selecting.value = false
  if (!value) return

  replies.value = []
  status.value = t('globals.terms.loading')
  try {
    const response = await api.searchMacros({ view: 'replying', message_only: true })
    if (version !== requestVersion) return
    replies.value = response.data.data || []
    status.value = replies.value.length ? '' : t('replyBox.noQuickReplies')
  } catch (error) {
    if (version === requestVersion) status.value = handleHTTPError(error).message
  }
}

const selectReply = async (id) => {
  if (props.disabled || selecting.value) return
  const version = requestVersion
  selecting.value = true
  try {
    const response = await api.getMacro(id)
    if (version !== requestVersion || props.disabled) return
    const reply = response.data.data
    if (!reply?.message_content || !reply.visible_when.includes('replying')) {
      setOpen(true)
      return
    }
    emit('insert', reply.message_content)
    setOpen(false)
  } catch (error) {
    if (version !== requestVersion) return
    emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
      variant: 'destructive',
      description: handleHTTPError(error).message
    })
  } finally {
    if (version === requestVersion) selecting.value = false
  }
}

onBeforeUnmount(() => requestVersion++)
</script>
