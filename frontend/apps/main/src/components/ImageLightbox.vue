<template>
  <Teleport to="body">
    <div v-if="modelValue" @load.capture="onImageLoad">
      <VueEasyLightbox
        :key="attempt"
        :visible="viewerOpen"
        :imgs="imgs"
        :index="index"
        :loop="images.length > 1"
        @hide="close"
        @on-index-change="onIndexChange"
        @on-error="onImageError"
      >
        <template #loading><span hidden /></template>
        <template #onerror><span hidden /></template>
      </VueEasyLightbox>

      <div v-if="viewerOpen && state !== 'ready'" class="image-lightbox-preview">
        <img
          v-if="previewUrl && previewUrl !== failedPreviewUrl"
          :key="previewUrl"
          :src="previewUrl"
          :alt="currentImage?.name || ''"
          @error="failedPreviewUrl = $event.target.getAttribute('src')"
        />
        <div v-if="state !== 'loading' || !hasLoadedOriginal" class="image-lightbox-status">
          <span role="status">{{ $t(statusMessage) }}</span>
          <Button v-if="state !== 'loading'" size="sm" variant="secondary" @click="retry">
            {{ $t('globals.terms.tryAgain') }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import VueEasyLightbox from 'vue-easy-lightbox'
import { Button } from '@shared-ui/components/ui/button'

const LOAD_TIMEOUT_MS = 12_000

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  images: { type: Array, required: true },
  startIndex: { type: Number, default: 0 }
})
const emit = defineEmits(['update:modelValue'])

const index = ref(0)
const viewerOpen = ref(false)
const attempt = ref(0)
const state = ref('loading')
const failedPreviewUrl = ref('')
// Keep this in the current gallery and match the full URL, including its signature.
const loadedOriginals = reactive(new Set())
const currentImage = computed(() => props.images[index.value])
const originalUrl = computed(() => currentImage.value?.url)
const hasLoadedOriginal = computed(() => loadedOriginals.has(originalUrl.value))
const previewUrl = computed(() => hasLoadedOriginal.value
  ? originalUrl.value
  : currentImage.value?.previewUrl || currentImage.value?.thumbnail_url)
const statusMessage = computed(() => ({
  loading: 'conversation.imagePreviewLoading',
  timeout: 'conversation.imagePreviewTimeout',
  error: 'conversation.imagePreviewError'
})[state.value])
const imgs = computed(() => props.images.map(img => ({ src: img.url, title: img.name || '' })))

function close() {
  emit('update:modelValue', false)
}

function onIndexChange(_prev, next) {
  index.value = next
}

function step(delta) {
  const total = props.images.length
  if (total <= 1) return
  index.value = (index.value + delta + total) % total
}

function onImageLoad(event) {
  const image = event.target
  // Wait for the visible image so the thumbnail stays in place during the handoff.
  if (!viewerOpen.value || !image.classList?.contains('vel-img') ||
      !image.naturalWidth || image.getAttribute('src') !== originalUrl.value) return
  loadedOriginals.add(originalUrl.value)
  state.value = 'ready'
}

function onImageError(event) {
  if (!viewerOpen.value || event.target?.getAttribute('src') !== originalUrl.value) return
  loadedOriginals.delete(originalUrl.value)
  state.value = 'error'
}

async function retry() {
  viewerOpen.value = false
  attempt.value++
  await nextTick()
  if (props.modelValue) viewerOpen.value = true
}

const KEY_ACTIONS = {
  ArrowLeft: () => step(-1),
  ArrowRight: () => step(1),
  Escape: close,
  ArrowUp: () => {},
  ArrowDown: () => {},
  PageUp: () => {},
  PageDown: () => {}
}

// Capture so the message list doesn't also receive navigation keys.
function onDocKeydown(event) {
  const action = KEY_ACTIONS[event.key]
  if (!action) return
  event.preventDefault()
  event.stopPropagation()
  action()
}

watch(() => props.modelValue, async (open, _, onCleanup) => {
  viewerOpen.value = false
  if (!open) return

  index.value = Math.max(0, Math.min(props.startIndex, props.images.length - 1))
  document.addEventListener('keydown', onDocKeydown, true)
  onCleanup(() => document.removeEventListener('keydown', onDocKeydown, true))

  // The viewer initializes its scroll lock and image state when visibility changes.
  await nextTick()
  if (props.modelValue) viewerOpen.value = true
}, { immediate: true })

watch([viewerOpen, originalUrl], ([open, url], _, onCleanup) => {
  if (!open) return
  failedPreviewUrl.value = ''
  state.value = url ? 'loading' : 'error'
  if (!url) return
  const timer = window.setTimeout(() => {
    if (state.value === 'loading') state.value = 'timeout'
  }, LOAD_TIMEOUT_MS)
  onCleanup(() => window.clearTimeout(timer))
}, { flush: 'sync' })
</script>

<style>
.vel-img-wrapper,
.vel-img,
.vel-fade-enter-active,
.vel-fade-leave-active {
  transition: none !important;
}
</style>

<style scoped>
.image-lightbox-preview {
  position: fixed;
  inset: 4rem min(4rem, 12vw);
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: .75rem;
  pointer-events: none;
}

.image-lightbox-preview img {
  width: min(100%, 32rem);
  max-height: calc(100% - 3rem);
  object-fit: contain;
}

.image-lightbox-status {
  display: flex;
  align-items: center;
  gap: .5rem;
  border-radius: .5rem;
  padding: .5rem .75rem;
  background: rgb(0 0 0 / .75);
  color: white;
}

.image-lightbox-status button {
  pointer-events: auto;
}
</style>
