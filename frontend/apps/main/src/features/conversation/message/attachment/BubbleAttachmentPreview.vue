<template>
  <div class="flex flex-row flex-wrap gap-2 break-all">
    <BubbleAttachmentItem
      v-for="attachment in attachments"
      :key="attachment.uuid"
      :attachment="attachment"
      @preview="openLightbox"
    />
  </div>

  <ImageLightbox
    v-model="lightboxOpen"
    :images="imageAttachments"
    :start-index="lightboxIndex"
  />
</template>

<script setup>
import { ref, computed } from 'vue'
import BubbleAttachmentItem from '@/features/conversation/message/attachment/BubbleAttachmentItem.vue'
import ImageLightbox from '@/components/ImageLightbox.vue'

const props = defineProps({
  attachments: { type: Array, required: true }
})

const isImage = (attachment) => (attachment.content_type || '').startsWith('image/')

const openedPreview = ref(null)
const imageAttachments = computed(() => {
  const preview = openedPreview.value
  return (props.attachments || []).filter(isImage).map(attachment => preview && attachment.url === preview.original
    ? { ...attachment, previewUrl: preview.url }
    : attachment)
})

const lightboxOpen = ref(false)
const lightboxIndex = ref(0)

const openLightbox = (attachment, previewUrl) => {
  const idx = imageAttachments.value.findIndex((a) => a.uuid === attachment.uuid)
  openedPreview.value = previewUrl ? { original: attachment.url, url: previewUrl } : null
  lightboxIndex.value = idx >= 0 ? idx : 0
  lightboxOpen.value = true
}
</script>
