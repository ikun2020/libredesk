// Browser-supplied reference data. This never identifies or authenticates a user.
const attributes = new Set([
  'xboard_balance', 'xboard_used_traffic', 'xboard_total_traffic',
  'xboard_expires_at', 'xboard_plan'
])
const bytes = (value) => new TextEncoder().encode(value).length
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

export function normalizeVisitorProfile(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['email', 'contact_custom_attributes'].includes(key))) return null
  const email = value.email
  if (typeof email !== 'string' || bytes(email) > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) return null
  const source = value.contact_custom_attributes
  if (!plainObject(source)) return null
  const result = {}
  for (const [key, item] of Object.entries(source)) {
    if (!attributes.has(key) || typeof item !== 'string' || bytes(item) > 256 || /[\u0000-\u001f\u007f]/.test(item)) return null
    result[key] = item
  }
  return { email, contact_custom_attributes: result }
}

// Serialize updates so an older response cannot overwrite a newer profile.
// Before the first real message there is no token, hence no server-side record.
export function createVisitorProfileSync({ getToken, canSync, send }) {
  let profile = null
  let revision = 0
  let epoch = 0
  let pending = null
  let controller = null
  const clear = () => {
    epoch++
    revision++
    profile = null
    controller?.abort()
    controller = null
    pending = null
  }
  const flush = () => {
    if (!profile || !getToken() || !canSync()) return Promise.resolve()
    if (pending) return pending
    const generation = epoch
    const token = getToken()
    const abort = new AbortController()
    controller = abort
    pending = (async () => {
      let sent
      do {
        sent = revision
        const snapshot = profile
        try {
          await send(snapshot, token, abort.signal)
        } catch {
          // Retry on the next parent update. Do not log private profile data.
          return
        }
      } while (generation === epoch && token === getToken() && canSync() && profile && sent !== revision)
    })().finally(() => {
      if (generation === epoch) {
        pending = null
        controller = null
      }
    })
    return pending
  }
  return {
    clear,
    flush,
    get: () => profile ? structuredClone(profile) : null,
    set(value) {
      const next = normalizeVisitorProfile(value)
      if (!next) return false
      profile = next
      revision++
      void flush()
      return true
    }
  }
}
