import { expect, test, vi } from 'vitest'
import { createVisitorProfileSync, normalizeVisitorProfile } from './visitorProfile.js'

const profile = (plan = 'Basic') => ({ email: 'person@example.test', contact_custom_attributes: { xboard_plan: plan } })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { resolve, reject, promise } }

test.each([
  null, [], { ...profile(), external_user_id: 'victim' },
  { ...profile(), email: 'Name <person@example.test>' },
  { ...profile(), email: 'x'.repeat(255) + '@example.test' },
  { ...profile(), contact_custom_attributes: { admin: 'true' } },
  { ...profile(), contact_custom_attributes: { xboard_plan: { html: 'x' } } },
  profile('中'.repeat(100)), profile('Basic\nAdmin')
])('rejects unsupported or excessive data: %j', value => {
  expect(normalizeVisitorProfile(value)).toBeNull()
})

test('caches data without creating a visitor, conversation or message before chat', async () => {
  const send = vi.fn()
  const sync = createVisitorProfileSync({ getToken: () => '', canSync: () => true, send })
  expect(sync.set(profile())).toBe(true)
  await sync.flush()
  expect(send).not.toHaveBeenCalled()
  const copy = sync.get()
  copy.email = 'changed@example.test'
  expect(sync.get()).toEqual(profile())
})

test('serializes updates and sends only the newest waiting value', async () => {
  const first = deferred()
  const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
  const sync = createVisitorProfileSync({ getToken: () => 'guest-random-token', canSync: () => true, send })
  sync.set(profile('A'))
  sync.set(profile('B'))
  sync.set(profile('C'))
  expect(send).toHaveBeenCalledTimes(1)
  first.resolve()
  await sync.flush()
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls.map(call => call[0].contact_custom_attributes.xboard_plan)).toEqual(['A', 'C'])
})

test('clearing aborts an old update and cannot send a queued old profile to the next account', async () => {
  const first = deferred()
  const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
  let token = 'old-guest'
  const sync = createVisitorProfileSync({ getToken: () => token, canSync: () => true, send })
  sync.set(profile('A'))
  const oldPending = sync.flush()
  sync.set(profile('B'))
  sync.clear()
  expect(send.mock.calls[0][2].aborted).toBe(true)
  expect(sync.get()).toBeNull()
  token = 'new-guest'
  sync.set(profile('C'))
  first.resolve()
  await oldPending
  expect(send.mock.calls.map(call => [call[0].contact_custom_attributes.xboard_plan, call[1]])).toEqual([['A', 'old-guest'], ['C', 'new-guest']])
})

test('verified sessions do not receive unsigned updates and errors wait for the next refresh', async () => {
  let allowed = false
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const sync = createVisitorProfileSync({ getToken: () => 'token', canSync: () => allowed, send })
  sync.set(profile())
  expect(send).not.toHaveBeenCalled()
  allowed = true
  await sync.flush()
  expect(send).toHaveBeenCalledTimes(1)
  sync.set(profile())
  await sync.flush()
  expect(send).toHaveBeenCalledTimes(2)
})
