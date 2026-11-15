import { describe, expect, test } from 'vitest'
import { createRuleCopy, getRuleCopyTarget, getUnavailableConditionFields } from './rule-copy'

const incomingMessageEvent = 'conversation.message.incoming'

function sourceRule(type) {
  return {
    id: 17,
    name: 'Reply to greeting',
    description: 'Reply when a customer says hello',
    type,
    enabled: false,
    weight: 3,
    execution_mode: 'first_match',
    events: type === 'conversation_update' ? [incomingMessageEvent] : [],
    rules: [
      {
        groups: [
          {
            logical_op: 'AND',
            rules: [
              {
                field: 'content',
                field_type: 'conversation',
                operator: 'contains',
                value: 'hello'
              }
            ]
          },
          { logical_op: 'OR', rules: [] }
        ],
        actions: [{ type: 'send_reply', value: ['<p>Hello!</p>'] }],
        group_operator: 'OR'
      }
    ]
  }
}

describe('copying conversation rules', () => {
  test.each([
    ['new_conversation', 'conversation_update'],
    ['conversation_update', 'new_conversation']
  ])('copies %s to a new %s draft without carrying trigger or list settings', (sourceType, targetType) => {
    const original = sourceRule(sourceType)
    const initial = structuredClone(original)

    expect(getRuleCopyTarget(sourceType)).toBe(targetType)
    const copy = createRuleCopy(original, targetType)
    expect(copy).toEqual({
      name: original.name,
      description: original.description,
      type: targetType,
      events: [],
      rules: initial.rules
    })

    copy.rules[0].groups[0].rules[0].value = 'bye'
    copy.rules[0].actions[0].value[0] = '<p>Goodbye!</p>'
    copy.events.push(incomingMessageEvent)
    expect(original).toEqual(initial)
  })

  test('allows only copies between the two different conversation rule types', () => {
    expect(getRuleCopyTarget('time_trigger')).toBeNull()
    expect(createRuleCopy(sourceRule('time_trigger'), 'new_conversation')).toBeNull()
    expect(createRuleCopy(sourceRule('new_conversation'), 'time_trigger')).toBeNull()
    expect(createRuleCopy(sourceRule('conversation_update'), 'conversation_update')).toBeNull()
  })

  test('identifies unsupported conditions across both groups without treating customer fields as built-in', () => {
    const groups = [
      {
        rules: [
          { field: 'subject' },
          { field: 'content', field_type: 'conversation' },
          { field: 'customer_plan', field_type: 'contact_custom_attribute' }
        ]
      },
      { rules: [{ field: 'to' }, { field: 'subject' }, {}] }
    ]

    expect(getUnavailableConditionFields(groups, { content: {} })).toEqual(['subject', 'to'])
    expect(getUnavailableConditionFields(groups, { content: {}, subject: {}, to: {} })).toEqual([])
  })
})
