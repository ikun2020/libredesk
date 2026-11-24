// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import ImageLightbox from './ImageLightbox.vue'

const images = [
  { url: '/uploads/first?sig=original', thumbnail_url: '/uploads/thumb_first?sig=thumbnail', name: 'First' },
  { url: '/uploads/second?sig=original', thumbnail_url: '/uploads/thumb_second?sig=thumbnail', name: 'Second' }
]

let app
let host
let open
let gallery
const preview = () => document.querySelector('.image-lightbox-preview img')
const originalRequest = () => document.querySelector('.vel-modal > img')
const status = () => document.querySelector('.image-lightbox-preview [role="status"]')?.textContent

async function paint() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(80)
  await nextTick()
}

async function finishOriginal() {
  originalRequest().dispatchEvent(new Event('load'))
  await paint()
  const image = document.querySelector('.vel-img')
  Object.defineProperty(image, 'naturalWidth', { value: 900 })
  image.dispatchEvent(new Event('load'))
  await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()
  open = ref(false)
  gallery = ref(images)
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () => h(ImageLightbox, {
      modelValue: open.value,
      images: gallery.value,
      'onUpdate:modelValue': value => { open.value = value }
    })
  })
  app.config.globalProperties.$t = key => key
  app.mount(host)
})

afterEach(() => {
  app.unmount()
  host.remove()
  vi.useRealTimers()
})

it('shows the thumbnail first and uses the loaded original when reopening', async () => {
  expect(originalRequest()).toBeNull()
  open.value = true
  await paint()
  expect(preview().getAttribute('src')).toBe(images[0].thumbnail_url)
  expect(originalRequest().getAttribute('src')).toBe(images[0].url)
  expect(status()).toBe('conversation.imagePreviewLoading')

  await finishOriginal()
  expect(preview()).toBeNull()

  open.value = false
  await paint()
  expect(originalRequest()).toBeNull()
  open.value = true
  await paint()
  expect(preview().getAttribute('src')).toBe(images[0].url)
  expect(status()).toBeUndefined()
})

it('keeps the preview on timeout or error, and retries the same signed URL', async () => {
  open.value = true
  await paint()
  await vi.advanceTimersByTimeAsync(12_000)
  expect(status()).toBe('conversation.imagePreviewTimeout')
  expect(preview().getAttribute('src')).toBe(images[0].thumbnail_url)

  const previous = originalRequest()
  document.querySelector('.image-lightbox-status button').click()
  await paint()
  expect(originalRequest()).not.toBe(previous)
  expect(originalRequest().getAttribute('src')).toBe(images[0].url)
  originalRequest().dispatchEvent(new Event('error'))
  await nextTick()
  expect(status()).toBe('conversation.imagePreviewError')
  expect(preview().getAttribute('src')).toBe(images[0].thumbnail_url)
})

it('shows the selected thumbnail and gives the new image its own time limit', async () => {
  open.value = true
  await paint()
  await vi.advanceTimersByTimeAsync(6_000)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  await paint()
  expect(originalRequest().getAttribute('src')).toBe(images[1].url)
  expect(preview().getAttribute('src')).toBe(images[1].thumbnail_url)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(status()).toBe('conversation.imagePreviewLoading')
  await finishOriginal()
  expect(preview()).toBeNull()
})

it('accepts the preloader success without requiring the visible image to report a second load', async () => {
  open.value = true
  await paint()
  const preloader = originalRequest()
  Object.defineProperty(preloader, 'naturalWidth', { value: 900 })
  preloader.dispatchEvent(new Event('load'))
  await paint()
  await vi.advanceTimersByTimeAsync(12_000)
  expect(preview()).toBeNull()
  expect(status()).toBeUndefined()
  expect(document.querySelector('.vel-img')?.getAttribute('src')).toBe(images[0].url)
})

it('prefers the server preview and can retry using the signed original', async () => {
  const previewUrl = `${images[0].url}&preview=1`
  gallery.value = [{ ...images[0], preview_url: previewUrl }]
  open.value = true
  await paint()
  expect(originalRequest().getAttribute('src')).toBe(previewUrl)
  originalRequest().dispatchEvent(new Event('error'))
  await nextTick()
  document.querySelector('.image-lightbox-status button').click()
  await paint()
  expect(originalRequest().getAttribute('src')).toBe(images[0].url)
})
