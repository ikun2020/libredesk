<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        ref="trigger"
        type="button"
        :variant="duo ? 'outline' : 'ghost'"
        size="icon"
        :class="duo ? 'size-11 rounded-full' : 'shrink-0'"
        :title="t('conversation.bulkActions.inboxMenu')"
        :aria-label="t('conversation.bulkActions.inboxMenu')"
        :disabled="!scope || submitting"
      >
        <MoreHorizontal class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem @select="begin(RESOLVED)">
        {{ t(actionLabels[RESOLVED]) }}
      </DropdownMenuItem>
      <DropdownMenuItem @select="begin(CLOSED)">
        {{ t(actionLabels[CLOSED]) }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <AlertDialog :open="!!pending" @update:open="setDialogOpen">
    <AlertDialogContent @close-auto-focus="restoreFocus">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ pending ? t(actionLabels[pending.status]) : '' }}</AlertDialogTitle>
        <AlertDialogDescription aria-live="polite">
          <template v-if="previewError">{{ previewError }}</template>
          <template v-else-if="!preview">{{ t('globals.terms.loading') }}</template>
          <template v-else-if="preview.total">
            {{ t('conversation.bulkActions.confirmAllOpen', { inbox: inboxTitle, count: preview.total }, preview.total) }}
            <span v-if="listChanged" class="mt-2 block">{{ t('conversation.bulkActions.inboxChanged') }}</span>
          </template>
          <template v-else>{{ t('conversation.bulkActions.noOpenConversations') }}</template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="submitting">{{ t('globals.messages.cancel') }}</AlertDialogCancel>
        <Button
          v-if="preview?.total && pending"
          type="button"
          :variant="pending.status === CLOSED ? 'destructive' : 'default'"
          :is-loading="submitting"
          @click="apply"
        >
          {{ t(actionLabels[pending.status]) }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup>
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MoreHorizontal } from 'lucide-vue-next'
import { Button } from '@shared-ui/components/ui/button'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@shared-ui/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from '@shared-ui/components/ui/dropdown-menu'
import api from '@main/api'
import { useEmitter } from '@main/composables/useEmitter'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents'
import { CONVERSATION_DEFAULT_STATUSES } from '@main/constants/conversation'
import { useConversationStore } from '@main/stores/conversation'

const props = defineProps({ scope: Object, inboxTitle: String, duo: Boolean })
const { RESOLVED, CLOSED } = CONVERSATION_DEFAULT_STATUSES
const actionLabels = {
  [RESOLVED]: 'conversation.bulkActions.resolveAllOpen',
  [CLOSED]: 'conversation.bulkActions.closeAllOpen'
}

const { t } = useI18n()
const emitter = useEmitter()
const conversationStore = useConversationStore()
const trigger = ref(null)
const pending = shallowRef(null)
const preview = ref(null)
const previewError = ref('')
const listChanged = ref(false)
const submitting = ref(false)
const scopeKey = computed(() => JSON.stringify(props.scope))

watch(scopeKey, () => { pending.value = null })

function setDialogOpen (open) {
  if (!open && !submitting.value) pending.value = null
}

function restoreFocus (event) {
  event.preventDefault()
  const button = trigger.value?.$el
  const target = button?.disabled ? button.closest('header')?.querySelector('h1') : button
  target?.focus()
}

function refreshInbox (action) {
  if (action.scopeKey === scopeKey.value) {
    conversationStore.resetConversations()
    void conversationStore.fetchFirstPageConversations()
  }
  void conversationStore.fetchSidebarCounts({ force: true })
}

async function loadPreview (action) {
  preview.value = null
  previewError.value = ''
  try {
    const response = await api.updateInboxOpenConversationStatus({ ...action.params, preview: true })
    if (pending.value === action) preview.value = response.data.data
  } catch {
    if (pending.value === action) previewError.value = t('globals.messages.somethingWentWrong')
  }
}

function begin (status) {
  if (!props.scope || submitting.value) return
  const action = { status, scopeKey: scopeKey.value, params: { ...props.scope, status } }
  listChanged.value = false
  pending.value = action
  void loadPreview(action)
}

async function apply () {
  const action = pending.value
  if (!action || action.scopeKey !== scopeKey.value || !preview.value?.snapshot || submitting.value) return
  submitting.value = true
  try {
    const { data: { data: result } } = await api.updateInboxOpenConversationStatus({
      ...action.params,
      snapshot: preview.value.snapshot
    })
    pending.value = null
    refreshInbox(action)
    emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
      variant: result.failed ? 'destructive' : undefined,
      description: result.skipped || result.failed
        ? t('conversation.bulkActions.inboxPartialResult', result)
        : t('conversation.bulkActions.successToast')
    })
  } catch (error) {
    if (error.response?.status === 409 && pending.value === action) {
      listChanged.value = true
      await loadPreview(action)
    } else {
      pending.value = null
      refreshInbox(action)
      emitter.emit(EMITTER_EVENTS.SHOW_TOAST, {
        variant: 'destructive',
        description: t('globals.messages.somethingWentWrong')
      })
    }
  } finally {
    submitting.value = false
  }
}
</script>
