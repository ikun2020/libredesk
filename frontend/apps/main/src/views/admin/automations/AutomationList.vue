<template>
  <div>
    <div v-if="selectedTab">
      <AutomationTabs v-model:automationsTab="selectedTab">
        <template #actions>
          <Button type="button" @click="newRule">{{ $t('automation.newRule') }}</Button>
        </template>
      </AutomationTabs>
    </div>
  </div>
</template>

<script setup>
import { Button } from '@shared-ui/components/ui/button'
import { useRoute, useRouter } from 'vue-router'
import { useStorage } from '@vueuse/core'
import AutomationTabs from '@/features/admin/automation/AutomationTabs.vue'
import { getRuleCopyTarget } from '@/features/admin/automation/rule-copy'

const router = useRouter()
const route = useRoute()
const selectedTab = useStorage('automationsTab', 'new_conversation')
if (getRuleCopyTarget(route.query.type)) selectedTab.value = route.query.type
const newRule = () => {
  router.push({ name: 'new-automation', query: { type: selectedTab.value } })
}
</script>
