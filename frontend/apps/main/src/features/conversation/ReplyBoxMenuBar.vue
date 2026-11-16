<template>
  <div
    class="relative flex min-h-14 shrink-0 flex-wrap justify-between gap-y-2"
    :class="{ 'items-end': isFullscreen, 'items-center': !isFullscreen }"
  >
    <div class="flex items-center gap-1">
      <input
        type="file"
        class="hidden"
        ref="attachmentInput"
        multiple
        :accept="attachmentAccept"
        @change="handleFileUpload"
      />
      <!-- <input
        type="file"
        class="hidden"
        ref="inlineImageInput"
        accept="image/*"
        @change="handleInlineImageUpload"
      /> -->
      <!-- Editor buttons -->
      <Tooltip>
        <TooltipTrigger as-child>
          <Toggle
            :class="ICON_BUTTON_CLASS"
            variant="outline"
            :aria-label="$t('globals.messages.attachFile')"
            @click="triggerFileUpload"
            :pressed="false"
          >
            <Paperclip class="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{{ $t('globals.messages.attachFile') }}</TooltipContent>
      </Tooltip>
      <FaceEmojiPicker @select="emit('emojiSelect', $event)">
        <template #trigger>
          <Tooltip>
            <TooltipTrigger as-child>
              <PopoverTrigger as-child>
                <Button
                  type="button"
                  :class="[ICON_BUTTON_CLASS, 'data-[state=open]:bg-muted']"
                  variant="outline"
                  :aria-label="$t('globals.messages.addEmoji')"
                >
                  <Smile class="size-4" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{{ $t('globals.messages.addEmoji') }}</TooltipContent>
          </Tooltip>
        </template>
      </FaceEmojiPicker>
      <Tooltip>
        <TooltipTrigger as-child>
          <Toggle
            :class="[ICON_BUTTON_CLASS, 'md:hidden']"
            variant="outline"
            :aria-label="$t('actions.applyMacro')"
            @click="openMacroPicker"
            :pressed="false"
          >
            <Zap class="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{{ $t('actions.applyMacro') }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="showWhatsAppTemplate">
        <TooltipTrigger as-child>
          <Toggle
            :class="ICON_BUTTON_CLASS"
            variant="outline"
            :aria-label="$t('globals.messages.sendTemplate')"
            @click="openTemplatePicker"
            :pressed="false"
          >
            <WhatsAppIcon class="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{{ $t('globals.messages.sendTemplate') }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="showGenerateReply">
        <TooltipTrigger as-child>
          <Toggle
            :class="ICON_BUTTON_CLASS"
            variant="outline"
            :pressed="false"
            :disabled="isGenerating"
            :aria-label="$t('replyBox.generateReply')"
            @click="emit('generateReply')"
          >
            <Loader2 v-if="isGenerating" class="h-4 w-4 animate-spin" />
            <Sparkles v-else class="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{{ $t('replyBox.generateReply') }}</TooltipContent>
      </Tooltip>
    </div>
    <div v-if="showSendButton" class="ml-auto flex items-center gap-2">
      <slot name="before-send" />
      <div class="flex items-center rounded-md shadow-sm">
        <Button
          class="h-8 max-md:h-11 px-4 rounded-r-none"
          @click="handleSend"
          :disabled="!enableSend"
          :isLoading="isSending"
        >
          {{ $t('globals.messages.send') }}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              class="h-8 max-md:h-11 px-2 rounded-l-none border-l border-primary-foreground/30 [&[data-state=open]>svg]:rotate-180"
              :disabled="!enableSend"
            >
              <ChevronDownIcon class="text-primary-foreground transition-transform" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{{ $t('replyBox.sendAndSetAs') }}</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="status in conversationStore.statusOptionsNoSnooze"
              :key="status.value"
              @click="handleSendAndSetStatus(status.label)"
            >
              {{ status.label }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </div>
</template>

<script setup>
const ICON_BUTTON_CLASS =
  'border-border/70 bg-background px-2 py-2 text-muted-foreground shadow-none max-md:min-h-11 max-md:min-w-11'

import { ref, computed } from 'vue'
import { Button } from '@shared-ui/components/ui/button'
import { Toggle } from '@shared-ui/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@shared-ui/components/ui/tooltip'
import { PopoverTrigger } from '@shared-ui/components/ui/popover'
import FaceEmojiPicker from '@shared-ui/components/FaceEmojiPicker.vue'
import { Paperclip, Smile, Zap, ChevronDownIcon, Sparkles, Loader2 } from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel
} from '@shared-ui/components/ui/dropdown-menu'
import WhatsAppIcon from '@main/components/icons/WhatsAppIcon.vue'
import { useConversationStore } from '@main/stores/conversation'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents.js'
import { WHATSAPP_MEDIA_ACCEPT } from '@main/features/conversation/whatsappMedia'
import { MACROS_COMMAND, useCommandPalette } from '@main/features/command/useCommandPalette'

const attachmentInput = ref(null)
const emit = defineEmits(['emojiSelect', 'generateReply'])

const props = defineProps({
  isFullscreen: Boolean,
  isWhatsApp: Boolean,
  showWhatsAppTemplate: Boolean,
  isSending: Boolean,
  isGenerating: Boolean,
  enableSend: Boolean,
  handleSend: Function,
  handleSendAndSetStatus: Function,
  showSendButton: {
    type: Boolean,
    default: true
  },
  showGenerateReply: {
    type: Boolean,
    default: true
  },
  handleFileUpload: Function,
  handleInlineImageUpload: Function
})

const triggerFileUpload = () => {
  if (attachmentInput.value) {
    // Clear the value to allow the same file to be uploaded again.
    attachmentInput.value.value = ''
    attachmentInput.value.click()
  }
}

const conversationStore = useConversationStore()
const emitter = useEmitter()
const palette = useCommandPalette()

const attachmentAccept = computed(() => (props.isWhatsApp ? WHATSAPP_MEDIA_ACCEPT : undefined))

const openMacroPicker = () => {
  palette.openPalette({ parent: MACROS_COMMAND })
}

const openTemplatePicker = () => {
  emitter.emit(EMITTER_EVENTS.WHATSAPP_TEMPLATE_PICKER_OPEN)
}
</script>
