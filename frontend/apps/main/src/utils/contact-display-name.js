export function getContactDisplayName(contact) {
  const { type, first_name, last_name, email } = contact ?? {}

  if (type === 'visitor' && first_name === 'Visitor' && !last_name?.trim() && email?.trim()) {
    return email.trim()
  }

  return [first_name, last_name].filter(Boolean).join(' ')
}
