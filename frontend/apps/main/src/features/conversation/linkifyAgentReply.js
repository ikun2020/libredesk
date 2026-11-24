import { find } from 'linkifyjs'

const excludedText = 'a, code, pre, script, style, textarea, svg, math'
const chinesePunctuation = /[。！？、，；：）】》「」“”‘’]/gu
const nonWebScheme = /\b(?:javascript|vbscript|data|file|ftp|ftps|mailto|tel|sms|ws|wss):\/{0,2}$/i

export function linkifyAgentReply(html) {
  if (!html) return html

  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(excludedText)) textNodes.push(node)
  }

  let changed = false
  for (const node of textNodes) {
    const source = node.data
    // Staff template variables are resolved after sending and can form part of a URL.
    if (source.includes('{{')) continue
    // Keep offsets intact so punctuation can be retained in the original text.
    const linkText = source.replace(chinesePunctuation, ' ')
    let result
    let offset = 0
    for (const match of find(linkText, 'url', { defaultProtocol: 'https' })) {
      if (!/^https?:\/\//i.test(match.href) || nonWebScheme.test(source.slice(0, match.start))) continue
      // Separate adjacent Chinese prose from an ASCII hostname or URL.
      const prefix = match.value.match(/^\p{Script=Han}+(?=[A-Za-z0-9])/u)?.[0] || ''
      const start = match.start + prefix.length
      const label = source.slice(start, match.end)

      const href = /^https?:\/\//i.test(label) ? label : `https://${label}`
      let url
      try {
        url = new URL(href)
      } catch {
        continue
      }
      if (url.username || url.password) continue

      result ??= document.createDocumentFragment()
      result.append(source.slice(offset, start))
      const anchor = document.createElement('a')
      anchor.href = url.href
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer nofollow'
      anchor.textContent = label
      result.append(anchor)
      offset = match.end
    }
    if (result) {
      result.append(source.slice(offset))
      node.replaceWith(result)
      changed = true
    }
  }
  return changed ? template.innerHTML : html
}
