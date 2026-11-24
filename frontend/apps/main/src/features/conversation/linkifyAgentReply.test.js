// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { linkifyAgentReply } from './linkifyAgentReply'

const parse = (html) => new DOMParser().parseFromString(html, 'text/html').body
const links = (body) => [...body.querySelectorAll('a')].map(anchor => [
  anchor.textContent,
  anchor.href
])

describe('linkifyAgentReply', () => {
  it('links recognized bare domains through the end of a reply using HTTPS', () => {
    const body = parse(linkifyAgentReply('<p>example.com example.cn example.org example.is</p>'))

    expect(links(body)).toEqual([
      ['example.com', 'https://example.com/'],
      ['example.cn', 'https://example.cn/'],
      ['example.org', 'https://example.org/'],
      ['example.is', 'https://example.is/']
    ])
  })

  it('keeps paths, query strings, and explicit HTTP links in formatted text', () => {
    const body = parse(linkifyAgentReply(
      '<p><strong>example.cn/help?q=one&amp;n=2#setup</strong> (http://example.org/docs).</p>'
    ))

    expect(links(body)).toEqual([
      ['example.cn/help?q=one&n=2#setup', 'https://example.cn/help?q=one&n=2#setup'],
      ['http://example.org/docs', 'http://example.org/docs']
    ])
    expect(body.querySelector('strong > a')).not.toBeNull()
    expect(body.textContent).toBe('example.cn/help?q=one&n=2#setup (http://example.org/docs).')
  })

  it('leaves adjacent Chinese text and punctuation outside the link', () => {
    const text = '请访问example.is，备用地址是https://example.cn/help。再试example.org'
    const body = parse(linkifyAgentReply(`<p>${text}</p>`))

    expect(links(body)).toEqual([
      ['example.is', 'https://example.is/'],
      ['https://example.cn/help', 'https://example.cn/help'],
      ['example.org', 'https://example.org/']
    ])
    expect(body.textContent).toBe(text)
  })

  it('preserves existing links, code, and attributes', () => {
    const html = '<p title="example.com">' +
      '<a href="https://example.org/docs" class="button">example.cn</a> ' +
      '<code>example.is</code> <img src="https://example.com/example.cn.png" alt="example.org">' +
      '</p><pre><code>https://example.com</code></pre>'
    const body = parse(linkifyAgentReply(html))

    expect(links(body)).toEqual([['example.cn', 'https://example.org/docs']])
    expect(body.querySelector('a').className).toBe('button')
    expect(body.querySelector('code').textContent).toBe('example.is')
    expect(body.querySelector('pre code').textContent).toBe('https://example.com')
    expect(body.querySelector('p').title).toBe('example.com')
    expect(body.querySelector('img').getAttribute('src')).toBe('https://example.com/example.cn.png')
    expect(body.querySelector('img').alt).toBe('example.org')
  })

  it('keeps emails and non-web schemes as text', () => {
    const html = '<p>help+desk@example.com mailto:team@example.org ftp://example.cn javascript:example.is</p>'
    const body = parse(linkifyAgentReply(html))

    expect(links(body)).toEqual([])
    expect(body.textContent).toBe(parse(html).textContent)
  })

  it('keeps reply template URLs intact for server-side interpolation', () => {
    const html = '<p>example.com/ticket/{{ .Conversation.ReferenceNumber }}</p><p>example.is</p>'
    const body = parse(linkifyAgentReply(html))

    expect(links(body)).toEqual([['example.is', 'https://example.is/']])
    expect(body.firstElementChild.textContent).toBe('example.com/ticket/{{ .Conversation.ReferenceNumber }}')
  })
})
