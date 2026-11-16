<template>
  <div class="flex items-center gap-1">
    <input
      type="file"
      class="hidden"
      ref="fileInput"
      @change="handleFileUpload"
      :accept="fileUploadEnabled ? '*/*' : ''"
      :disabled="!fileUploadEnabled || !canUploadFiles || uploading || disabled"
    />

    <Button
      type="button"
      v-if="fileUploadEnabled && canUploadFiles"
      @click="triggerFileUpload"
      :disabled="uploading || disabled"
      :aria-busy="uploading || undefined"
      :aria-label="$t('globals.messages.attachFile')"
      variant="ghost"
      size="sm"
      class="h-8 w-8 p-0 hover:bg-muted/50 border-0"
    >
      <LoaderCircle
        v-if="uploading"
        class="h-4 w-4 animate-spin text-muted-foreground"
        aria-hidden="true"
      />
      <Paperclip v-else class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span v-if="uploading" class="sr-only" role="status">{{
        $t('globals.messages.uploading')
      }}</span>
    </Button>

    <FaceEmojiPicker
      v-if="emojiEnabled"
      close-on-select
      :disabled="disabled"
      @select="emit('emojiSelect', $event)"
    >
      <template #trigger>
        <PopoverTrigger as-child>
          <Button
            type="button"
            :disabled="disabled"
            :title="$t('globals.messages.addEmoji')"
            :aria-label="$t('globals.messages.addEmoji')"
            variant="ghost"
            size="sm"
            class="h-8 w-8 p-0 hover:bg-muted/50 border-0 data-[state=open]:bg-muted"
          >
            <Smile class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
      </template>
    </FaceEmojiPicker>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Button } from '@shared-ui/components/ui/button'
import { PopoverTrigger } from '@shared-ui/components/ui/popover'
import FaceEmojiPicker from '@shared-ui/components/FaceEmojiPicker.vue'
import { Smile, Paperclip, LoaderCircle } from 'lucide-vue-next'

const props = defineProps({
  fileUploadEnabled: {
    type: Boolean,
    default: false
  },
  emojiEnabled: {
    type: Boolean,
    default: false
  },
  uploading: {
    type: Boolean,
    default: false
  },
  canUploadFiles: {
    type: Boolean,
    default: true
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['fileUpload', 'emojiSelect'])

const fileInput = ref(null)

const triggerFileUpload = () => {
  if (
    fileInput.value &&
    props.fileUploadEnabled &&
    props.canUploadFiles &&
    !props.uploading &&
    !props.disabled
  ) {
    fileInput.value.value = ''
    fileInput.value.click()
  }
}

const handleFileUpload = (event) => {
  if (!props.fileUploadEnabled || !props.canUploadFiles || props.uploading || props.disabled) return
  const files = event.target.files
  if (files && files.length > 0) {
    emit('fileUpload', files)
  }
}
</script>
