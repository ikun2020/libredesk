describe('Live chat keyword auto-replies', () => {
  const keyword = '优惠券'
  // Include the keyword in the reply too, so duplicate/self-triggered replies are visible.
  const reply = '优惠券：123456'
  let inbox
  let session
  let ruleIDs

  const createRule = (type) =>
    cy.api('POST', '/api/v1/automations/rules', {
      name: `Keyword ${type} ${inbox.id}`,
      description: 'Live chat keyword regression',
      type,
      enabled: true,
      events: type === 'conversation_update' ? ['conversation.message.incoming'] : [],
      rules: [{
        group_operator: 'AND',
        groups: [{
          logical_op: 'AND',
          rules: [
            { field: 'inbox', field_type: 'conversation', operator: 'equals', value: String(inbox.id) },
            { field: 'content', field_type: 'conversation', operator: 'contains', value: keyword }
          ]
        }],
        actions: [{ type: 'send_reply', value: [`<p>${reply}</p>`] }]
      }]
    }).then(({ status, body }) => {
      expect(status).to.eq(200)
      ruleIDs.push(body.data.id)
    })

  const startConversation = (message) =>
    cy.then(() => cy.widgetInit(inbox.uuid, { message })).then((created) => {
      session = created
    })

  const sendMessage = (message) =>
    cy.then(() => cy.widgetApi(
      'POST',
      `/api/v1/widget/chat/conversations/${session.conversationUuid}/message`,
      session.sessionToken,
      inbox.uuid,
      { message }
    ).its('status').should('eq', 200))

  const replies = () =>
    cy.api('GET', `/api/v1/conversations/${session.conversationUuid}/messages?type=outgoing`)
      .then(({ status, body }) => {
        expect(status).to.eq(200)
        return body.data.results.filter((message) => message.text_content.trim() === reply)
      })

  const waitForReplies = (count, attempts = 40) =>
    replies().then((messages) => {
      expect(messages.length, 'no duplicate automatic replies').to.be.at.most(count)
      if (messages.length === count) return messages
      if (attempts === 0) throw new Error(`Expected ${count} keyword replies, got ${messages.length}`)
      // eslint-disable-next-line cypress/no-unnecessary-waiting -- retry the asynchronous automation worker
      return cy.wait(250, { log: false }).then(() => waitForReplies(count, attempts - 1))
    })

  // Negative assertions need a bounded observation window after the worker's positive reply.
  const assertNoExtraReplies = (count, attempts = 8) =>
    replies().then((messages) => {
      expect(messages, 'keyword reply count stays unchanged').to.have.length(count)
      if (attempts === 0) return messages
      // eslint-disable-next-line cypress/no-unnecessary-waiting -- observe that no delayed/recursive reply appears
      return cy.wait(250, { log: false }).then(() => assertNoExtraReplies(count, attempts - 1))
    })

  beforeEach(() => {
    ruleIDs = []
    cy.createLivechatInbox().then((created) => {
      inbox = created
      return createRule('new_conversation')
    }).then(() => createRule('conversation_update'))
  })

  afterEach(() => {
    cy.login()
    ruleIDs.forEach((id) => {
      cy.api('DELETE', `/api/v1/automations/rules/${id}`, null, { failOnStatusCode: false })
    })
    // The shared livechat support hook removes each inbox after the spec.
  })

  it('replies to matching follow-ups, including after reopening a resolved conversation', () => {
    startConversation('你好，我有一个问题')
    cy.then(() => assertNoExtraReplies(0))

    sendMessage('请问有没有优惠券？')
    cy.then(() => waitForReplies(1))

    sendMessage('谢谢，收到了')
    cy.then(() => assertNoExtraReplies(1))

    cy.then(() => cy.api(
      'PUT', `/api/v1/conversations/${session.conversationUuid}/status`, { status: 'Resolved' }
    ).its('status').should('eq', 200))

    sendMessage('我还想问一下优惠券')
    cy.then(() => waitForReplies(2))
    cy.then(() => cy.api('GET', `/api/v1/conversations/${session.conversationUuid}`))
      .its('body.data.status').should('eq', 'Open')
    cy.then(() => assertNoExtraReplies(2))
  })

  it('still replies once when the first message contains the keyword', () => {
    startConversation('优惠券怎么领？')
    cy.then(() => waitForReplies(1))
    cy.then(() => assertNoExtraReplies(1))
  })
})
