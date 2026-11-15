export function getRuleCopyTarget(type) {
  if (type === 'new_conversation') return 'conversation_update'
  if (type === 'conversation_update') return 'new_conversation'
  return null
}

export function createRuleCopy(source, targetType) {
  if (!targetType || getRuleCopyTarget(source?.type) !== targetType) return null

  return {
    name: source.name,
    description: source.description,
    type: targetType,
    events: [],
    rules: structuredClone(source.rules)
  }
}

export function getUnavailableConditionFields(groups, filters) {
  const fields = new Set()
  for (const group of groups) {
    for (const condition of group.rules ?? []) {
      if (
        condition.field &&
        condition.field_type !== 'contact_custom_attribute' &&
        !Object.hasOwn(filters, condition.field)
      ) {
        fields.add(condition.field)
      }
    }
  }
  return [...fields]
}
