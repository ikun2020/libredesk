const editor = () => cy.get('.tiptap.ProseMirror[contenteditable="true"]:visible')
const sendButton = () => cy.contains('button', /^Send$/)
const visitorMessage = 'Touch composer visitor'

// CI uses Electron. CDP changes both CSS and JavaScript pointer media queries;
// stubbing matchMedia alone would leave the touch layout's CSS untested. Width
// and height queries remain native as cy.viewport folds/resizes the viewport.
const emulatePointer = (pointer) => cy.then(() =>
  Cypress.automation('remote:debugger:protocol', {
    command: 'Emulation.setTouchEmulationEnabled',
    params: { enabled: pointer === 'coarse', maxTouchPoints: 1 }
  })
)

const expectInlineLayout = (viewportHeight) => {
  editor().should('have.length', 1).should(($editor) => {
    expect($editor.closest('[role="dialog"]'), 'composer stays inline').to.have.length(0)
  })

  // Visibility alone permits off-screen elements. Check both the viewport and
  // the message scroller without scrolling the page to make the assertions pass.
  cy.contains('[data-message-uuid] .native-html', visitorMessage)
    .should('be.visible')
    .should(($message) => {
      const message = $message[0].getBoundingClientRect()
      const history = $message.closest('.overscroll-contain')[0].getBoundingClientRect()
      expect(history.height, 'space remains for chat history').to.be.at.least(48)
      expect(history.top, 'history starts inside the viewport').to.be.at.least(0)
      expect(history.bottom, 'history stays above the keyboard').to.be.at.most(viewportHeight + 1)
      expect(message.bottom, 'visitor message is below the top of the history').to.be.greaterThan(history.top)
      expect(message.top, 'visitor message is above the bottom of the history').to.be.lessThan(history.bottom)
    })

  sendButton().should('be.visible').should(($button) => {
    const rect = $button[0].getBoundingClientRect()
    const win = $button[0].ownerDocument.defaultView
    expect(rect.top, 'send button starts inside the viewport').to.be.at.least(0)
    expect(rect.bottom, 'send button stays above the keyboard').to.be.at.most(viewportHeight + 1)
    expect(rect.left, 'send button is not clipped on the left').to.be.at.least(0)
    expect(rect.right, 'send button is not clipped on the right').to.be.at.most(win.innerWidth + 1)
  })
}

const expectSameFocusedEditor = (editableNode, draft) => {
  editor().should(($editor) => {
    expect($editor[0], 'the editor must not be remounted').to.equal(editableNode)
    expect(editableNode.isConnected, 'editor remains attached').to.eq(true)
    expect(editableNode.ownerDocument.activeElement, 'focus survives resizing').to.equal(editableNode)
  }).and('contain.text', draft)
}

describe('Reply composer on touch screens', () => {
  let conversationUuid

  beforeEach(() => {
    emulatePointer('fine')
    cy.viewport(1280, 900)
    cy.createLivechatInbox().then((inbox) => {
      cy.widgetInit(inbox.uuid, { message: visitorMessage }).then((session) => {
        conversationUuid = session.conversationUuid
      })
    })
  })

  afterEach(() => emulatePointer('fine'))

  const openConversation = (pointer, { minimized = false, beforeLoad } = {}) => {
    emulatePointer(pointer)
    cy.intercept('GET', '**/messages?page=*').as('loadMessages')
    cy.visit(`/inboxes/all/conversation/${conversationUuid}`, {
      onBeforeLoad(win) {
        win.localStorage.setItem('replyBoxMinimized', String(minimized))
        beforeLoad?.(win)
      }
    })
    cy.wait('@loadMessages')
    cy.window().should((win) => {
      expect(win.matchMedia(`(pointer: ${pointer})`).matches, 'native primary pointer query').to.eq(true)
    })
  }

  const sendReply = (draft) => {
    cy.intercept('POST', `**/conversations/${conversationUuid}/messages`).as('sendReply')
    sendButton().should('be.enabled').click({ scrollBehavior: false })
    cy.wait('@sendReply').then(({ request, response }) => {
      expect(response.statusCode).to.eq(200)
      expect(request.body.message).to.include(draft)
      expect(request.body.private).to.eq(false)
    })
    cy.api('GET', `/api/v1/conversations/${conversationUuid}/messages`).then(({ body }) => {
      expect(JSON.stringify(body.data)).to.include(draft)
    })
  }

  for (const { name, width, height, minimized } of [
    { name: 'unfolded', width: 1280, height: 900, minimized: false },
    { name: 'narrow', width: 390, height: 700, minimized: true }
  ]) {
    it(`allows direct inline typing and sending on a ${name} touch screen across keyboard and fold changes`, () => {
      cy.viewport(width, height)
      openConversation('coarse', { minimized })
      expectInlineLayout(height)

      const draft = `${name} touch screen reply draft`
      let editableNode
      // Check click focus before typing: .type() can otherwise focus the editor
      // itself and conceal the original one-tap keyboard-opening regression.
      editor().click('center', { scrollBehavior: false })
      editor().should('be.focused')
      editor().type(draft, { scrollBehavior: false })
      editor().then(($editor) => { editableNode = $editor[0] })

      // The editor remains mounted through keyboard height changes and folding.
      // These are layout/focus tests; Cypress does not open a physical keyboard.
      for (const [nextWidth, nextHeight] of [[1280, 400], [390, 700], [390, 400], [1024, 700], [1024, 400]]) {
        cy.viewport(nextWidth, nextHeight)
        cy.then(() => expectSameFocusedEditor(editableNode, draft))
        expectInlineLayout(nextHeight)
      }

      // Touch defaults must not overwrite the user's saved desktop preference.
      cy.window().then((win) => {
        expect(win.localStorage.getItem('replyBoxMinimized')).to.eq(String(minimized))
      })
      editor().type(' after resize', { scrollBehavior: false })
      sendReply(`${draft} after resize`)
    })
  }

  it('keeps inline chat and send visible when only the visual viewport shrinks', () => {
    cy.viewport(390, 844)
    let visualViewport
    openConversation('coarse', {
      beforeLoad(win) {
        // Older iOS leaves the layout viewport unchanged when its keyboard
        // opens. Supply an independent visual viewport with real resize events.
        visualViewport = Object.assign(new win.EventTarget(), {
          width: win.innerWidth,
          height: win.innerHeight,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1
        })
        Object.defineProperty(win, 'visualViewport', {
          configurable: true,
          value: visualViewport
        })
      }
    })

    const draft = 'Visual viewport keyboard draft'
    let editableNode
    editor().click('center', { scrollBehavior: false })
    editor().should('be.focused')
    editor().type(`${draft}${'{enter}Another draft line'.repeat(12)}`, { scrollBehavior: false })
    editor().then(($editor) => { editableNode = $editor[0] })

    for (const height of [400, 600, 844]) {
      cy.window().then((win) => {
        expect(win.innerHeight, 'layout viewport does not resize').to.eq(844)
        visualViewport.height = height
        visualViewport.dispatchEvent(new win.Event('resize'))
      })
      cy.then(() => expectSameFocusedEditor(editableNode, draft))
      expectInlineLayout(height)
    }
  })

  it('preserves the draft when manually entering fullscreen and returning inline', () => {
    cy.viewport(390, 700)
    openConversation('coarse')
    const draft = 'Manual fullscreen draft'
    editor().click('center', { scrollBehavior: false })
    editor().should('be.focused')
    editor().type(draft, { scrollBehavior: false })
    cy.get('[data-testid="reply-fullscreen-toggle"]').click({ scrollBehavior: false })
    editor().closest('[role="dialog"]').should('be.visible')
    editor().should('contain.text', draft).click({ scrollBehavior: false })
    editor().type('{end} continued in fullscreen', { scrollBehavior: false })
    cy.get('[role="dialog"] [data-testid="reply-fullscreen-toggle"]').click({ scrollBehavior: false })
    cy.get('[role="dialog"]').should('not.exist')
    editor().should('contain.text', `${draft} continued in fullscreen`)
    expectInlineLayout(700)
    sendReply(`${draft} continued in fullscreen`)
  })

  it('keeps a wide desktop composer inline when the viewport height changes', () => {
    openConversation('fine')
    let editableNode
    editor().click({ scrollBehavior: false })
    editor().should('be.focused')
    editor().type('Desktop draft', { scrollBehavior: false })
    editor().then(($editor) => { editableNode = $editor[0] })
    cy.viewport(1280, 400)
    editor().should(($editor) => {
      expect($editor[0]).to.equal(editableNode)
      expect($editor.closest('[role="dialog"]')).to.have.length(0)
      expect(editableNode.ownerDocument.activeElement).to.equal(editableNode)
    }).and('contain.text', 'Desktop draft')
  })
})
