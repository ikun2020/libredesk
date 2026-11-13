const editor = () => cy.get('.tiptap.ProseMirror[contenteditable="true"]:visible')

// Emulate the primary input without freezing width/height media queries. Native
// matchMedia still dispatches change events as cy.viewport resizes the browser.
const emulatePointer = (win, pointer) => {
  const matchMedia = win.matchMedia.bind(win)
  cy.stub(win, 'matchMedia').callsFake((query) =>
    matchMedia(query.replace(/\(pointer:\s*(coarse|fine|none)\)/g, (_, kind) =>
      kind === pointer ? '(min-width: 0px)' : '(max-width: 0px)'
    ))
  )
}

describe('Reply composer on touch screens', () => {
  let conversationUuid

  beforeEach(() => {
    cy.viewport(1280, 900)
    cy.createLivechatInbox().then((inbox) => {
      cy.widgetInit(inbox.uuid, { message: 'Touch composer visitor' }).then((session) => {
        conversationUuid = session.conversationUuid
      })
    })
  })

  const openConversation = (pointer) => {
    cy.intercept('GET', '**/messages?page=*').as('loadMessages')
    cy.visit(`/inboxes/all/conversation/${conversationUuid}`, {
      onBeforeLoad(win) {
        win.localStorage.removeItem('replyBoxMinimized')
        emulatePointer(win, pointer)
      }
    })
    cy.wait('@loadMessages')
  }

  it('keeps the same focused editor and draft when an unfolded touch screen resizes', () => {
    openConversation('coarse')
    editor().should('not.exist')
    cy.contains('button', /^Reply$/).click()
    editor().closest('[role="dialog"]').should('be.visible')

    const draft = 'Touch screen reply draft'
    let editableNode
    editor().click().type(draft)
    editor().then(($editor) => { editableNode = $editor[0] })

    // Cover keyboard height changes and folding/unfolding while composing.
    // This exercises layout and focus persistence, not a physical iOS keyboard.
    for (const [width, height] of [[1280, 400], [390, 700], [1024, 700], [1024, 400]]) {
      cy.viewport(width, height)
      editor().should(($editor) => {
        expect($editor[0], 'the editor must not be remounted').to.equal(editableNode)
        expect(editableNode.isConnected, 'editor remains attached').to.eq(true)
        expect(editableNode.ownerDocument.activeElement, 'focus survives resizing').to.equal(editableNode)
      }).and('contain.text', draft)
      editor().closest('[role="dialog"]').should('be.visible')
    }

    editor().type(' after resize')
    cy.intercept('POST', `**/conversations/${conversationUuid}/messages`).as('sendReply')
    cy.get('[role="dialog"]').contains('button', /^Send$/).should('be.visible').click()
    cy.wait('@sendReply').then(({ request, response }) => {
      expect(response.statusCode).to.eq(200)
      expect(request.body.message).to.include(`${draft} after resize`)
      expect(request.body.private).to.eq(false)
    })
    cy.api('GET', `/api/v1/conversations/${conversationUuid}/messages`).then(({ body }) => {
      expect(JSON.stringify(body.data)).to.include(`${draft} after resize`)
    })
  })

  it('keeps a wide desktop composer inline when the viewport height changes', () => {
    openConversation('fine')
    let editableNode
    editor().click().type('Desktop draft')
    editor().then(($editor) => { editableNode = $editor[0] })
    cy.viewport(1280, 400)
    editor().should(($editor) => {
      expect($editor[0]).to.equal(editableNode)
      expect($editor.closest('[role="dialog"]')).to.have.length(0)
      expect(editableNode.ownerDocument.activeElement).to.equal(editableNode)
    }).and('contain.text', 'Desktop draft')
  })
})
