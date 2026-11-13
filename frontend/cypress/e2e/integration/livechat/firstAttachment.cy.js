const initPath = '/api/v1/widget/chat/conversations/init'
const startText = 'Cypress start with attachment'
const quickReply = 'Cypress quick reply'

const widgetConfig = (overrides = {}) => ({
  features: { file_upload: true, emoji: true },
  visitors: {
    allow_start_conversation: true,
    start_conversation_button_text: startText,
    quick_replies: [quickReply]
  },
  users: { allow_start_conversation: true, start_conversation_button_text: startText },
  ...overrides
})

const textFile = (fileName = 'first-file.txt', contents = 'First attachment from the visitor') => ({
  contents: Cypress.Buffer.from(contents),
  fileName,
  mimeType: 'text/plain'
})

const selectFile = (file) =>
  cy.widgetBody().find('input[type="file"]').selectFile(file, { force: true })

const incomingMessages = (uuid) =>
  cy.api('GET', `/api/v1/conversations/${uuid}/messages?type=incoming`)
    .its('body.data.results')

const assertOnlyConversation = (inbox, uuid) =>
  cy.api('GET', '/api/v1/conversations/all?order=desc&order_by=conversations.created_at&page=1&page_size=50')
    .then(({ body }) => {
      const conversations = body.data.results.filter((item) => item.inbox_name === inbox.payload.name)
      expect(conversations, 'one conversation for the first file and follow-ups').to.have.length(1)
      expect(conversations[0].uuid).to.eq(uuid)
    })

// Send multipart directly to exercise server-side validation independently of the UI.
const initWithFile = (inbox, { payload = {}, file = textFile(), headers = {} } = {}) => {
  const boundary = `cypress-widget-${Date.now()}`
  let body = `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify({ message: '', ...payload })}\r\n`
  if (file) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n${file.contents.toString()}\r\n`
  }
  body += `--${boundary}--\r\n`
  return cy.request({
    method: 'POST',
    url: initPath,
    headers: {
      'X-Libredesk-Inbox-ID': inbox.uuid,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers
    },
    body,
    failOnStatusCode: false
  })
}

describe('Live chat first-message attachments', () => {
  it('starts with an image, preserves the text draft, and keeps follow-ups in the same conversation', () => {
    const draft = 'Details to send after the image'
    let inbox
    let uuid
    let releaseInitialResponse

    cy.createLivechatInbox(widgetConfig()).then((created) => { inbox = created })
    cy.intercept('POST', initPath, (req) => {
      // Hold the real response until the busy-state assertions finish.
      req.continue(() => new Cypress.Promise((resolve) => { releaseInitialResponse = resolve }))
    }).as('initAttachment')
    cy.intercept('POST', '**/api/v1/widget/chat/conversations/*/message').as('sendText')
    cy.intercept('POST', '**/api/v1/widget/media/upload').as('uploadFollowUp')
    cy.then(() => cy.openWidget(inbox))
    cy.widgetBody().contains(startText).click()
    cy.widgetBody().find('button[aria-label="Attach file"]').should('be.visible').and('not.be.disabled')

    // Cancelling the picker must not create an empty conversation.
    cy.widgetBody().find('input[type="file"]').then(($input) => {
      cy.stub($input[0], 'click').as('filePicker')
    })
    cy.widgetBody().find('button[aria-label="Attach file"]').click()
    cy.get('@filePicker').should('have.been.calledOnce')
    cy.widgetBody().find('input[type="file"]').trigger('change', { force: true })
    cy.get('@initAttachment.all').should('have.length', 0)

    cy.widgetBody().find('textarea').type(draft)
    selectFile('../static/public/launcher-logo.png')
    cy.wrap(null).should(() => { expect(releaseInitialResponse).to.be.a('function') })
    cy.widgetBody().find('button[aria-label="Attach file"]').should('be.disabled')
    cy.widgetBody().find('button[aria-label="Send"]').should('be.disabled')
    cy.widgetBody().contains('button', quickReply).should('be.disabled')
    cy.widgetBody().find('textarea').trigger('keydown', { key: 'Enter', shiftKey: false, force: true })
    cy.get('@initAttachment.all').should('have.length', 1)
    cy.get('@sendText.all').should('have.length', 0)
    cy.then(() => releaseInitialResponse())

    cy.wait('@initAttachment').then(({ request, response }) => {
      expect(request.headers['content-type']).to.include('multipart/form-data')
      expect(response.statusCode).to.eq(200)
      expect(response.body.data.session_token).to.be.a('string').and.not.be.empty
      uuid = response.body.data.conversation.uuid
    })
    cy.widgetBody().find('[data-message-uuid] img[alt="launcher-logo.png"]').should('be.visible')
    cy.widgetBody().find('textarea').should('have.value', draft)
    cy.then(() => incomingMessages(uuid)).then((messages) => {
      expect(messages, 'no dummy opening text message').to.have.length(1)
      expect(messages[0].text_content).to.eq('')
      expect(messages[0].attachments).to.have.length(1)
      expect(messages[0].attachments[0].name).to.eq('launcher-logo.png')
    })

    cy.widgetBody().find('button[aria-label="Send"]').click()
    cy.wait('@sendText').then(({ request, response }) => {
      expect(request.url).to.include(`/conversations/${uuid}/message`)
      expect(request.body.message).to.eq(draft)
      expect(response.statusCode).to.eq(200)
    })
    cy.then(() => cy.waitForWidgetCookie(inbox))
    cy.reload()
    cy.widgetLauncher().click()
    cy.widgetBody().contains('[role="tab"]', 'Messages').click()
    cy.widgetBody().contains('button', draft).click()
    cy.widgetBody().find('[data-message-uuid] img[alt="launcher-logo.png"]').should('be.visible')

    selectFile(textFile('follow-up.txt'))
    cy.wait('@uploadFollowUp').its('response.statusCode').should('eq', 200)
    cy.widgetBody().contains('[data-message-uuid]', 'follow-up.txt').should('be.visible')
    cy.then(() => incomingMessages(uuid)).then((messages) => {
      expect(messages).to.have.length(3)
      expect(messages.filter((message) => message.text_content === draft)).to.have.length(1)
      expect(messages.flatMap((message) => message.attachments || []).map((file) => file.name))
        .to.have.members(['launcher-logo.png', 'follow-up.txt'])
    })
    cy.get('@initAttachment.all').should('have.length', 1)
    cy.then(() => assertOnlyConversation(inbox, uuid))
  })

  it('recovers from a failed first upload and allows choosing the same file again', () => {
    const draft = 'Keep this draft after a failed upload'
    const errorText = 'Temporary upload failure'
    let inbox
    let uuid

    cy.createLivechatInbox(widgetConfig()).then((created) => { inbox = created })
    cy.intercept({ method: 'POST', url: initPath, times: 1 }, {
      statusCode: 500,
      body: { message: errorText }
    }).as('failedInit')
    cy.then(() => cy.openWidget(inbox))
    cy.widgetBody().contains(startText).click()
    cy.widgetBody().find('textarea').type(draft)
    selectFile(textFile())
    cy.wait('@failedInit').its('response.statusCode').should('eq', 500)
    cy.widgetBody().contains(errorText).should('be.visible')
    cy.widgetBody().find('textarea').should('have.value', draft)
    cy.widgetBody().find('button[aria-label="Attach file"]').should('not.be.disabled')
    cy.then(() => cy.conversationForInbox(inbox)).should('be.null')

    cy.intercept('POST', initPath).as('retryInit')
    cy.widgetBody().find('input[type="file"]').then(($input) => {
      cy.stub($input[0], 'click').as('retryPicker')
    })
    cy.widgetBody().find('button[aria-label="Attach file"]').click()
    cy.get('@retryPicker').should('have.been.calledOnce')
    cy.widgetBody().find('input[type="file"]').should('have.value', '')
    selectFile(textFile())
    cy.wait('@retryInit').then(({ response }) => {
      expect(response.statusCode).to.eq(200)
      uuid = response.body.data.conversation.uuid
    })
    cy.widgetBody().contains('[data-message-uuid]', 'first-file.txt').should('be.visible')
    cy.widgetBody().should('not.contain.text', errorText)
    cy.widgetBody().find('textarea').should('have.value', draft)
    cy.then(() => incomingMessages(uuid)).should('have.length', 1)
    cy.then(() => assertOnlyConversation(inbox, uuid))
  })

  it('uses the verified contact identity when their first message is a file', () => {
    const stamp = Date.now()
    const email = `first-file.${stamp}@cypress.test`
    const secret = `first-file-secret-${stamp}`
    let inbox
    let uuid

    cy.createLivechatInbox(widgetConfig({ visitors: { allow_start_conversation: false } }), { secret })
      .then((created) => { inbox = created })
    cy.intercept('POST', '/api/v1/widget/chat/auth/exchange').as('exchange')
    cy.intercept('POST', initPath).as('contactInit')
    cy.then(() => cy.visitWidgetHost(inbox.uuid, {
      secret,
      jwtPayload: { external_user_id: `first_file_${stamp}`, email, first_name: 'File Visitor' }
    }))
    cy.wait('@exchange').its('response.statusCode').should('eq', 200)
    cy.widgetLauncher().click()
    cy.widgetBody().contains(startText).click()
    selectFile(textFile('contact-file.txt'))
    cy.wait('@contactInit').then(({ request, response }) => {
      expect(request.headers.authorization).to.match(/^Bearer /)
      expect(response.statusCode).to.eq(200)
      uuid = response.body.data.conversation.uuid
    })
    cy.widgetBody().contains('[data-message-uuid]', 'contact-file.txt').should('be.visible')
    cy.then(() => cy.latestConversation(inbox)).its('contact.email').should('eq', email)
    cy.then(() => incomingMessages(uuid)).then((messages) => {
      expect(messages).to.have.length(1)
      expect(messages[0].attachments[0].name).to.eq('contact-file.txt')
    })
  })

  it('persists a campaign invitation and its first attachment reply without duplicating the conversation', () => {
    // These keys are scoped to this test's newly created inbox.
    const campaignID = '5b8c6f14-e657-4806-ae80-a7550e5e7312'
    const browserKey = '6305be5f-0ee6-40b0-b979-e6405f22ba3b'
    const sessionKey = '946779ad-0a4d-4250-b497-857e1f64881d'
    const invitation = 'Send us a file so we can help'
    const contents = 'The first reply to this invitation is an attachment'
    let inbox
    let deliveryID
    let uuid
    let sessionToken

    cy.createLivechatInbox(widgetConfig({
      campaign_cooldown: '0s',
      campaigns: [{
        id: campaignID,
        name: 'First attachment invitation',
        enabled: true,
        message: invitation,
        audience: 'visitors',
        business_hours: 'any',
        desktop: true,
        mobile: true,
        repeat: 'once',
        repeat_hours: 24,
        delay_seconds: 0
      }]
    })).then((created) => { inbox = created })

    // Reserve and display a real invitation, without relying on popup timers.
    cy.then(() => cy.widgetApi('POST', '/api/v1/widget/chat/campaigns/next', null, inbox.uuid, {
      url: `${Cypress.config('baseUrl')}/__widget-embed-test`,
      browser_key: browserKey,
      session_key: sessionKey,
      active_seconds: 0,
      mobile: false
    })).then(({ status, body }) => {
      expect(status).to.eq(200)
      expect(body.data.campaign_id).to.eq(campaignID)
      deliveryID = body.data.id
    })
    cy.then(() => cy.widgetApi('POST', '/api/v1/widget/chat/campaigns/event', null, inbox.uuid, {
      delivery_id: deliveryID, browser_key: browserKey, event: 'displayed'
    })).its('status').should('eq', 200)
    cy.then(() => cy.conversationForInbox(inbox)).should('be.null')

    cy.then(() => initWithFile(inbox, {
      payload: { delivery_id: deliveryID, browser_key: browserKey },
      file: textFile('campaign-first.txt', contents)
    })).then(({ status, body }) => {
      expect(status).to.eq(200)
      uuid = body.data.conversation.uuid
      sessionToken = body.data.session_token
      expect(sessionToken).to.be.a('string').and.not.be.empty
    })
    cy.then(() => cy.api('GET', `/api/v1/conversations/${uuid}/messages?type=incoming&type=outgoing`))
      .its('body.data.results').then((messages) => {
        expect(messages, 'persisted invitation plus attachment-only reply').to.have.length(2)
        expect(messages.filter((message) => message.type === 'outgoing').map((message) => message.text_content))
          .to.deep.eq([invitation])
        const reply = messages.find((message) => message.type === 'incoming')
        expect(reply.text_content).to.eq('')
        expect(reply.attachments).to.have.length(1)
        expect(reply.attachments[0].name).to.eq('campaign-first.txt')
        expect(reply.attachments[0].uuid).to.be.a('string').and.not.be.empty
        // Verify the uploaded bytes, not just an attachment entry in the response.
        cy.request(reply.attachments[0].url).its('body').should('eq', contents)
      })

    // Reusing the delivery after its first reply must append to the same conversation.
    cy.then(() => initWithFile(inbox, {
      payload: { delivery_id: deliveryID, browser_key: browserKey },
      headers: { Authorization: `Bearer ${sessionToken}` },
      file: textFile('campaign-next.txt')
    })).then(({ status, body }) => {
      expect(status).to.eq(200)
      expect(body.data.conversation.uuid).to.eq(uuid)
    })
    cy.then(() => incomingMessages(uuid)).then((messages) => {
      expect(messages).to.have.length(2)
      expect(messages.map((message) => message.text_content)).to.deep.eq(['', ''])
      expect(messages.flatMap((message) => message.attachments).map((file) => file.name))
        .to.have.members(['campaign-first.txt', 'campaign-next.txt'])
    })
    cy.then(() => cy.api('GET', `/api/v1/conversations/${uuid}/messages?type=outgoing`))
      .its('body.data.results').should('have.length', 1)
    cy.then(() => assertOnlyConversation(inbox, uuid))
  })

  it('rejects empty first uploads without creating a conversation', () => {
    cy.createLivechatInbox(widgetConfig()).then((inbox) => {
      initWithFile(inbox, { file: textFile('empty.txt', '') }).its('status').should('eq', 400)
      initWithFile(inbox, { file: null }).its('status').should('eq', 400)
      cy.conversationForInbox(inbox).should('be.null')
    })
  })

  for (const [name, overrides] of [
    ['file uploads are disabled', { features: { file_upload: false } }],
    ['visitors cannot start conversations', { visitors: { allow_start_conversation: false } }],
    ['a required pre-chat field is missing', {
      prechat_form: {
        enabled: true,
        fields: [{ key: 'name', type: 'text', label: 'Name', required: true, enabled: true, order: 1, is_default: true }]
      }
    }]
  ]) {
    it(`rejects attachment-only init when ${name}`, () => {
      cy.createLivechatInbox(widgetConfig(overrides)).then((inbox) => {
        initWithFile(inbox).its('status').should('eq', 400)
        cy.conversationForInbox(inbox).should('be.null')
      })
    })
  }
})
