import { compareMessageEditTimes } from '@shared-ui/utils/message-edits.js'

export default class MessageCache {
    // Not reactive - see widget/store/chat.js for the reactive wrapper pattern.
    constructor(maxConvs = 30) {
        this.cache = new Map()
        this.maxConvs = maxConvs
        this.recentConvs = []
    }

    addMessages (convId, messages, page, totalPages) {
        const conv = this._getOrCreateConversation(convId)
        const uniqueMsgs = []
        let changed = false
        const known = new Set(this._allMessages(convId).map(message => message.uuid))
        for (const message of messages) {
            if (message.edited_at || message.recalled_at) {
                changed = this.applyPublicMessageUpdate(convId, message) || changed
            }
            if (known.has(message.uuid)) continue
            known.add(message.uuid)
            const update = conv.publicUpdates.get(message.uuid)
            uniqueMsgs.push(update ? { ...message, ...update } : message)
        }

        if (page >= conv.lastFetchedPage && messages.length > 0) {
            conv.historyTail = messages.at(-1).uuid
        }
        conv.lastFetchedPage = Math.max(page, conv.lastFetchedPage)
        conv.hasMore = totalPages > conv.lastFetchedPage
        conv.totalPages = totalPages
        conv.pages.set(page, [...(conv.pages.get(page) || []), ...uniqueMsgs])
        if (page === 1) {
            conv.latestFetchedAt = Math.max(0, ...messages.map(message => Date.parse(message.created_at) || 0))
        }
        return changed || uniqueMsgs.length > 0
    }

    purgeConversation (convId) {
        return this.cache.delete(convId)
    }

    hasMessage (convId, msgId) {
        return this.getMessage(convId, msgId) !== undefined
    }

    getMessage (convId, msgId) {
        return this._allMessages(convId).find(m => m.uuid === msgId)
    }

    addMessage (convId, message) {
        const conv = this._getOrCreateConversation(convId)
        if (this.hasMessage(convId, message.uuid)) return
        if (message.edited_at || message.recalled_at) this.applyPublicMessageUpdate(convId, message)
        const update = conv.publicUpdates.get(message.uuid)
        const entry = update ? { ...message, ...update } : message
        if (!conv.pages.has(1)) {
            conv.pages.set(1, [entry])
        } else {
            conv.pages.get(1).push(entry)
        }
    }

    getAllPagesMessages (convId) {
        return this._allMessages(convId)
            .filter(message => !message.recalled_at)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || (a.id || 0) - (b.id || 0))
    }

    getLatestMessage (convId, type = [], excludePrivate = false, excludeAutomated = false) {
        const filtered = this._allMessages(convId).filter(msg => {
            if (msg.recalled_at) return false
            if (type.length > 0 && !type.includes(msg.type)) return false
            if (excludePrivate && msg.private) return false
            if (excludeAutomated && msg.meta?.is_automated) return false
            return true
        })
        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || (b.id || 0) - (a.id || 0))
        return filtered.length ? filtered[0] : null
    }

    updateMessage (convId, msgId, updates) {
        this._updateMessageBy(convId, msgId, msg => Object.assign(msg, updates))
    }

    applyPublicMessageUpdate (convId, message) {
        const conv = this._getOrCreateConversation(convId)
        const cached = this.getMessage(convId, message.uuid)
        const previous = conv.publicUpdates.get(message.uuid) || cached
        if (previous?.recalled_at) return false
        if (!message.recalled_at && previous?.edited_at &&
            compareMessageEditTimes(previous.edited_at, message.edited_at) >= 0) return false

        // Keep a blank slot so an edit response or an in-flight history request cannot restore a recall.
        const update = message.recalled_at
            ? { content: '', text_content: '', attachments: [], recalled_at: message.recalled_at }
            : {
                content: message.content,
                text_content: message.text_content,
                content_type: message.content_type,
                edited_at: message.edited_at
            }
        conv.publicUpdates.set(message.uuid, update)
        if (!cached) return false
        Object.assign(cached, update)
        return true
    }

    updateMessageField (convId, msgId, field, value) {
        this._updateMessageBy(convId, msgId, msg => { msg[field] = value })
    }

    removeMessage (convId, msgId) {
        const conv = this.cache.get(convId)
        if (!conv) return
        conv.pages.forEach(msgs => {
            const msgIndex = msgs.findIndex(m => m.uuid === msgId)
            if (msgIndex !== -1) {
                msgs.splice(msgIndex, 1)
            }
        })
    }

    hasMore (convId) {
        return this.cache.get(convId)?.hasMore || false
    }

    getLastFetchedPage (convId) {
        return this.cache.get(convId)?.lastFetchedPage || 0
    }

    getLatestFetchedAt (convId) {
        return this.cache.get(convId)?.latestFetchedAt || 0
    }

    getHistoryTail (convId) {
        return this.cache.get(convId)?.historyTail
    }

    getLatestPersistedAt (convId) {
        return this._allMessages(convId).reduce((latest, message) =>
            message.id > 0 ? Math.max(latest, Date.parse(message.created_at) || 0) : latest, 0)
    }

    pruneOldConversations (convId) {
        this.recentConvs = [convId, ...this.recentConvs.filter(id => id !== convId)]
        if (this.recentConvs.length > this.maxConvs) {
            const removed = this.recentConvs.pop()
            this.cache.delete(removed)
        }
    }

    hasConversation (convId) {
        return this.cache.has(convId)
    }

    _getOrCreateConversation (convId) {
        if (!this.cache.has(convId)) {
            this.cache.set(convId, {
                pages: new Map(),
                publicUpdates: new Map(),
                totalPages: 0,
                lastFetchedPage: 0,
                hasMore: false,
            })
            this.pruneOldConversations(convId)
        }
        return this.cache.get(convId)
    }

    _allMessages (convId) {
        const conv = this.cache.get(convId)
        if (!conv) return []
        return Array.from(conv.pages.values()).flat()
    }

    _updateMessageBy (convId, msgId, mutate) {
        const conv = this.cache.get(convId)
        if (!conv) return
        conv.pages.forEach(msgs => {
            const msg = msgs.find(m => m.uuid === msgId)
            if (msg) mutate(msg)
        })
    }
}
