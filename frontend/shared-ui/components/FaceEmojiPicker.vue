<template>
  <Popover v-model:open="open">
    <slot name="trigger" />
    <PopoverContent
      side="top"
      align="start"
      :side-offset="8"
      class="w-80 max-w-[calc(100vw-1rem)] max-h-[min(16rem,var(--radix-popover-content-available-height))] p-2"
      :aria-label="$t('globals.messages.addEmoji')"
      @close-auto-focus="handleCloseAutoFocus"
    >
      <div class="grid grid-cols-8 gap-0.5">
        <Button
          v-for="emoji in FACE_EMOJIS"
          :key="emoji"
          type="button"
          variant="ghost"
          class="h-9 min-w-0 p-0 text-xl leading-none"
          :disabled="disabled"
          @click="selectEmoji(emoji)"
        >
          {{ emoji }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup>
import { ref } from 'vue'
import { Button } from '@shared-ui/components/ui/button'
import { Popover, PopoverContent } from '@shared-ui/components/ui/popover'

// The original picker's face section, ending at the red goblin.
const FACE_EMOJIS = [
  '😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆',
  '😉', '😊', '😋', '😎', '😍', '😘', '😗', '😙',
  '😚', '☺️', '🙂', '🤗', '🤩', '🤔', '🤨', '😐',
  '😑', '😶', '🙄', '😏', '😣', '😥', '😮', '🤐',
  '😯', '😪', '😫', '😴', '😌', '😛', '😜', '😝',
  '🤤', '😒', '😓', '😔', '😕', '🙃', '🤑', '😲',
  '☹️', '🙁', '😖', '😞', '😟', '😤', '😢', '😭',
  '😦', '😧', '😨', '😩', '🤯', '😬', '😰', '😱',
  '😳', '🤪', '😵', '😡', '😠', '🤬', '😷', '🤒',
  '🤕', '🤢', '🤮', '🤧', '😇', '🤠', '🤡', '🤥',
  '🤫', '🤭', '🧐', '🤓', '😈', '👿', '👹', '👺',
]

const props = defineProps({ closeOnSelect: Boolean, disabled: Boolean })
const emit = defineEmits(['select'])
const open = ref(false)
let closingAfterSelection = false

const selectEmoji = (emoji) => {
  if (props.disabled) return
  if (props.closeOnSelect) {
    closingAfterSelection = true
    open.value = false
  }
  emit('select', emoji)
}

const handleCloseAutoFocus = (event) => {
  // The visitor composer moves focus back to the textarea after inserting a face.
  if (closingAfterSelection) event.preventDefault()
  closingAfterSelection = false
}
</script>
