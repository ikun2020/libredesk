describe('PWA notification preferences', () => {
  it('serves installable assets', () => {
    cy.request('/manifest.webmanifest').then(({ body, headers, status }) => {
      expect(status).to.eq(200)
      expect(headers['content-type']).to.include('application/manifest+json')
      expect(body.name).to.eq('Support')
      expect(body.display).to.eq('standalone')
      expect(body.launch_handler.client_mode).to.eq('navigate-existing')
      expect(body.icons.map((icon) => icon.sizes)).to.have.members(['192x192', '512x512'])
      for (const { src } of body.icons) {
        cy.request(src).its('headers.content-type').should('include', 'image/png')
      }
    })

    cy.request('/').then(({ body }) => {
      const page = new DOMParser().parseFromString(body, 'text/html')
      const icon = page.querySelector('link[rel="apple-touch-icon"]')
      expect(icon?.getAttribute('sizes')).to.eq('180x180')
      cy.request(icon.getAttribute('href')).its('headers.content-type').should('include', 'image/png')
    })

    cy.request('/sw.js').then(({ body, status }) => {
      expect(status).to.eq(200)
      expect(body).to.include("addEventListener('push'")
      expect(body).to.include("addEventListener('notificationclick'")
      expect(body).not.to.include("addEventListener('fetch'")
    })
  })
})
