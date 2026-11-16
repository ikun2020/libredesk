// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketClient } from './websocket'

vi.mock('./stores/conversation', () => ({
  useConversationStore: () => ({
    conversations: { data: [{ uuid: 'listed' }] },
    conversation: { data: { uuid: 'open' } },
    refreshInboxAfterResume: vi.fn()
  })
}))
vi.mock('./stores/notification', () => ({ useNotificationStore: () => ({ refreshAfterResume: vi.fn() }) }))
vi.mock('./stores/users', () => ({ useUsersStore: () => ({}) }))
vi.mock('./stores/user', () => ({ useUserStore: () => ({}) }))
vi.mock('./stores/connection', () => ({
  useConnectionStore: () => ({ setConnecting: vi.fn(), setConnectionFailed: vi.fn() })
}))

class Socket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = Socket.CONNECTING
  send = vi.fn()
  close = vi.fn(() => {
    if (this.readyState === Socket.CLOSED) return
    this.readyState = Socket.CLOSED
    this.dispatchEvent(new Event('close'))
  })

  open () {
    this.readyState = Socket.OPEN
    this.dispatchEvent(new Event('open'))
  }
}

describe('receiving messages after resuming the inbox', () => {
  let client
  let hidden

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', Socket)
    hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    client = new WebSocketClient()
    client.connect()
    client.socket.open()
    vi.advanceTimersByTime(4000)
  })

  afterEach(() => {
    client.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('probes once for paired foreground events and keeps a responding connection', () => {
    const socket = client.socket
    client.probeOnResume()
    client.probeOnResume()
    socket.dispatchEvent(new MessageEvent('message', { data: 'pong' }))
    client.probeOnResume()
    vi.advanceTimersByTime(4000)

    expect(socket.send.mock.calls).toEqual([['ping']])
    expect(socket.close).not.toHaveBeenCalled()
    expect(client.convStore.refreshInboxAfterResume).not.toHaveBeenCalled()
  })

  it('checks the socket after a new foreground transition even if it recently responded', () => {
    const socket = client.socket
    client.setupNetworkListeners()
    window.dispatchEvent(new Event('focus'))
    socket.dispatchEvent(new MessageEvent('message', { data: 'pong' }))

    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    expect(socket.send).toHaveBeenCalledOnce()

    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    expect(socket.send.mock.calls).toEqual([['ping'], ['ping']])
  })

  it('resubscribes and reconciles after a socket that still reports open stops answering', () => {
    const firstSocket = client.socket
    client.probeOnResume()
    vi.advanceTimersByTime(3000)
    expect(firstSocket.close).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(1000)
    expect(client.socket).not.toBe(firstSocket)
    client.socket.open()
    expect(client.socket.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: 'list_subscribe_replace', data: { uuids: ['listed'] } },
      { type: 'conversation_subscribe', data: { conversation_uuid: 'open' } }
    ])
    expect(client.convStore.refreshInboxAfterResume).toHaveBeenCalledOnce()
    expect(client.notificationStore.refreshAfterResume).toHaveBeenCalledOnce()
  })

  it('lets a pending handshake finish without sending a ping or restarting the connection', () => {
    const socket = client.socket
    socket.readyState = Socket.CONNECTING
    client.probeOnResume()
    vi.advanceTimersByTime(2000)
    socket.open()
    vi.advanceTimersByTime(2000)

    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('clears the probe and skips reconnect when manually closed', () => {
    const socket = client.socket
    client.probeOnResume()
    client.close()
    client.probeOnResume()
    vi.advanceTimersByTime(5000)

    expect(socket.send.mock.calls).toEqual([['ping']])
    expect(socket.close).toHaveBeenCalledOnce()
    expect(client.socket).toBe(socket)
    expect(client.convStore.refreshInboxAfterResume).not.toHaveBeenCalled()
  })
})
