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

const standaloneViewport = (win) => {
  const state = {
    hidden: false,
    viewport: Object.assign(new win.EventTarget(), {
      width: win.innerWidth, height: win.innerHeight, scale: 1,
      offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0
    })
  }
  // Use Safari's standalone flag; pointer media queries still come from CDP.
  Object.defineProperty(win.navigator, 'standalone', { configurable: true, value: true })
  Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => state.hidden })
  Object.defineProperty(win, 'visualViewport', { configurable: true, value: state.viewport })
  return state
}

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

  it('sends a desktop reply with Enter and keeps Shift+Enter for a newline', () => {
    openConversation('fine')
    cy.intercept('POST', `**/conversations/${conversationUuid}/messages`).as('sendReply')
    editor().type('First line{shift+enter}Second line')
    editor().find('br').should('exist')
    cy.get('@sendReply.all').should('have.length', 0)

    editor().type('{enter}')
    cy.wait('@sendReply').then(({ request, response }) => {
      expect(response.statusCode).to.eq(200)
      expect(request.body.message).to.include('First line<br>Second line')
      expect(request.body.private).to.eq(false)
    })
    cy.get('@sendReply.all').should('have.length', 1)
    editor().should('have.text', '')
  })

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

  it('keeps the inline editor and send button clickable while the keyboard pans the document', () => {
    cy.viewport(867, 669)
    let state
    let editableNode
    openConversation('coarse', {
      beforeLoad(win) {
        state = standaloneViewport(win)
        // Model the mobile layout viewport while the actual browser viewport
        // below shrinks. Do not enlarge body or #app: their real clipping bounds
        // must come from the application's layout, not a test-only min-height.
        Object.defineProperty(win.document.documentElement, 'clientHeight', {
          configurable: true,
          get: () => 669
        })
      }
    })
    const draft = 'Keyboard clipping regression draft'
    editor().click('center', { scrollBehavior: false })
    editor().should('be.focused').type(draft, { scrollBehavior: false })
    editor().then(($editor) => { editableNode = $editor[0] })

    const expectHitTarget = ($target) => {
      const node = $target[0]
      const rect = node.getBoundingClientRect()
      const hit = node.ownerDocument.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      )
      expect(node.contains(hit), 'center remains clickable through ancestor clipping').to.eq(true)
    }

    for (let cycle = 0; cycle < 2; cycle++) {
      // Leave the mocked visual viewport at 669 during the native resize so
      // there is initially enough document height for the real keyboard pan.
      cy.viewport(867, 337)
      cy.window().then((win) => {
        expect(win.innerHeight).to.eq(337)
        win.scrollTo(0, 332)
        expect(win.scrollY, 'reproduce the actual document displacement').to.eq(332)
        Object.assign(state.viewport, { height: 337, pageTop: 332, offsetTop: 332 })
        state.viewport.dispatchEvent(new win.Event('resize'))
        state.viewport.dispatchEvent(new win.Event('scroll'))
      })
      cy.get('.app-shell').should(($shell) => {
        const shell = $shell[0]
        const rect = shell.getBoundingClientRect()
        expect(rect.top, 'shell follows the keyboard pan').to.eq(0)
        expect(rect.height, 'shell fills the visible region').to.eq(337)
        expect(shell.ownerDocument.body.getBoundingClientRect().height,
          'body includes the pan space instead of clipping the shell').to.eq(669)
      })
      cy.then(() => expectSameFocusedEditor(editableNode, draft))
      // At this short height the history stays pinned to its newest content,
      // so an older message's text can legitimately be above its scroll window.
      // Check the history's usable viewport instead of requiring that specific
      // old message to be scrolled back into view automatically.
      cy.contains('[data-message-uuid] .native-html', visitorMessage)
        .closest('.overscroll-contain')
        .should(($history) => {
          const history = $history[0]
          const rect = history.getBoundingClientRect()
          expect(rect.height, 'space remains for chat history').to.be.at.least(48)
          expect(rect.top, 'history starts inside the viewport').to.be.at.least(0)
          expect(rect.bottom, 'history stays above the keyboard').to.be.at.most(338)
          expect(history.scrollHeight, 'older messages remain scrollable').to.be.greaterThan(history.clientHeight)
          expectHitTarget($history)
        })
      // A correct bounding box can still be hidden by overflow on an ancestor.
      // Hit-test both controls and use real actions without forced clicks or
      // automatic scrolling that could conceal that regression.
      editor().should(expectHitTarget).click('center', { scrollBehavior: false })
      editor().should('be.focused').type('{end} continued', { scrollBehavior: false })
      sendButton().should('be.enabled').should(expectHitTarget)
      if (cycle === 1) sendReply(draft)

      cy.viewport(867, 669)
      cy.window().then((win) => {
        Object.assign(state.viewport, { height: 669, pageTop: 0, offsetTop: 0 })
        win.scrollTo(0, 0)
        state.viewport.dispatchEvent(new win.Event('resize'))
        state.viewport.dispatchEvent(new win.Event('scroll'))
      })
      cy.get('.app-shell').should(($shell) => {
        const rect = $shell[0].getBoundingClientRect()
        expect(rect.top).to.eq(0)
        expect(rect.height).to.eq(669)
      })
    }
    // The override belongs to this document only; remove it for interactive
    // debugging as well. Subsequent tests also navigate to a fresh document.
    cy.window().then((win) => { delete win.document.documentElement.clientHeight })
  })

  it('realigns the unfolded standalone inbox after resume without resetting the list scroll', () => {
    let state
    let pane
    emulatePointer('coarse')
    cy.intercept('GET', '**/api/v1/conversations/all?*').as('loadInbox')
    cy.visit('/inboxes/all', {
      onBeforeLoad(win) { state = standaloneViewport(win) }
    })
    cy.wait('@loadInbox')
    cy.get('.app-shell h1').should('be.visible')
    // The loading indicator has a minimum display time, so the response can
    // finish before the rows render. Wait for a real row before scrolling;
    // replacing the skeletons would otherwise move the browser's scroll anchor.
    cy.get(`.app-shell a[href$="/conversation/${conversationUuid}"]`).should('be.visible')
    cy.get('.app-shell .overscroll-contain:visible').first().then(($pane) => {
      pane = $pane[0]
      // Make the inner pane scrollable independently of the test database size.
      const content = pane.ownerDocument.createElement('div')
      content.style.height = '1600px'
      pane.append(content)
      pane.scrollTop = 160
      expect(pane.scrollTop, 'list is scrolled before backgrounding').to.eq(160)
    })
    cy.window().then((win) => {
      state.hidden = true
      win.document.dispatchEvent(new win.Event('visibilitychange'))
      state.viewport.height = 500
      state.viewport.dispatchEvent(new win.Event('resize'))
      expect(win.document.documentElement.style.getPropertyValue('--visual-viewport-height')).to.eq('900px')

      // Reproduce a restored document scroll independently of pane scrolling.
      win.document.body.style.minHeight = '1400px'
      win.scrollTo(0, 84)
      expect(win.scrollY, 'document is displaced before recovery').to.eq(84)
      expect(win.document.querySelector('.app-shell').getBoundingClientRect().top).to.eq(-84)

      state.hidden = false
      win.document.dispatchEvent(new win.Event('visibilitychange'))
      // The final dimensions arrive after the foreground event, with no resize.
      state.viewport.height = 800
    })
    cy.get('.app-shell').should(($shell) => {
      const rect = $shell[0].getBoundingClientRect()
      expect(rect.top, 'root returns to the top').to.eq(0)
      expect(rect.height, 'late viewport measurement is applied').to.eq(800)
      expect(pane.scrollTop, 'list retains its own position').to.eq(160)
    })
    cy.window().then((win) => {
      win.document.body.style.removeProperty('min-height')
      state.viewport.height = 700
    })
    cy.viewport(390, 700)
    cy.get('.app-shell').should(($shell) => {
      expect($shell[0].getBoundingClientRect().top).to.eq(0)
      expect($shell[0].getBoundingClientRect().height).to.eq(700)
    })
  })

  it('keeps the same focused inline draft when a standalone app resumes with its keyboard', () => {
    let state
    let editableNode
    const draft = 'Reply retained across background restore'
    openConversation('coarse', { beforeLoad(win) { state = standaloneViewport(win) } })
    editor().click('center', { scrollBehavior: false }).type(draft, { scrollBehavior: false })
    editor().then(($editor) => { editableNode = $editor[0] })
    cy.window().then((win) => {
      cy.spy(win, 'scrollTo').as('rootScroll')
      state.hidden = true
      win.document.dispatchEvent(new win.Event('visibilitychange'))
      state.viewport.height = 0
      state.viewport.dispatchEvent(new win.Event('resize'))
      state.hidden = false
      state.viewport.height = 400
      win.document.dispatchEvent(new win.Event('visibilitychange'))
    })
    cy.then(() => expectSameFocusedEditor(editableNode, draft))
    expectInlineLayout(400)
    cy.get('@rootScroll').should('not.have.been.called')
    sendReply(draft)
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
