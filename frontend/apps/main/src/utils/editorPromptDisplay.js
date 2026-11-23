// Use the values seeded by schema.sql to recognize stock fields while preserving edits.
const defaultPrompts = new Map([
  ['make_friendly', {
    title: 'Make Friendly',
    content: 'Modify the text to make it more friendly and approachable.'
  }],
  ['make_concise', {
    title: 'Make Concise',
    content: 'Simplify the text to make it more concise and to the point.'
  }],
  ['add_empathy', {
    title: 'Add Empathy',
    content: 'Add empathy to the text while retaining the original meaning.'
  }],
  ['adjust_positive_tone', {
    title: 'Adjust Positive Tone',
    content: 'Adjust the tone of the text to make it sound more positive and reassuring.'
  }],
  ['make_professional', {
    title: 'Make Professional',
    content: 'Rephrase the text to make it sound more formal and professional and to the point.'
  }],
  ['fix_grammar_spelling', {
    title: 'Fix Grammar & Spelling',
    content: 'Fix any spelling and grammar mistakes in the text while retaining the original meaning and tone.'
  }]
])

export function editorPromptField(prompt, field, t) {
  const original = defaultPrompts.get(prompt.key)
  if (original && prompt[field] === original[field]) {
    return t(`admin.ai.editorPrompt.defaults.${prompt.key}.${field}`, prompt[field])
  }
  return prompt[field]
}
