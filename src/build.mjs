// Turns a deck into the review page.
//   embed: true   every picture is put inside the page, so the result is ONE file you can send anywhere
//   embed: false  pictures stay as files and the local server hands them out (fast for big decks)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadDeck, DeckError } from './deck.mjs'
import { MIME, imageSize, isVideo } from './images.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, 'template.html')

// The fonts go inside the page, so it looks the same everywhere and never fetches anything from the internet.
// Jersey 15 for titles and buttons, Atkinson Hyperlegible for reading. Both are under the SIL Open Font
// License; the licences are in src/fonts.
const FONTS = [
  ['Jersey 15', 400, 'jersey-15.woff2'],
  ['Atkinson Hyperlegible', 400, 'atkinson-hyperlegible-400.woff2'],
  ['Atkinson Hyperlegible', 700, 'atkinson-hyperlegible-700.woff2'],
]
let fontRules = null
const fontFace = () =>
  (fontRules ??= FONTS.map(
    ([family, weight, file]) =>
      `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; ` +
      `src: url(data:font/woff2;base64,${fs.readFileSync(path.join(HERE, 'fonts', file)).toString('base64')}) format("woff2"); }`,
  ).join('\n'))
const REMOTE = /^(https?:|data:)/i

// JSON that is safe inside a <script> tag: every "<" becomes the six characters backslash, u, 0, 0, 3, c,
// so card text can never close the tag early. JSON.parse and JavaScript both read that back as "<".
const LT_ESCAPE = String.fromCharCode(92) + 'u003c'
export const scriptSafe = (value) => JSON.stringify(value).replace(/</g, LT_ESCAPE)

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)

export function buildPage(input, { embed = true, token = '' } = {}) {
  const { deck, file, dir } = loadDeck(input)
  const images = {} // src as written in the deck -> { url, w, h }
  const files = [] // full paths of the pictures, in the order the server hands them out
  const demos = {} // demo src as written in the deck -> { url } or { html }
  const problems = []
  let bytes = 0

  for (const card of deck.cards) {
    for (const pic of card.images) {
      if (images[pic.src]) continue
      if (REMOTE.test(pic.src)) { images[pic.src] = { url: pic.src, w: 0, h: 0, video: isVideo(pic.src.split(/[?#]/)[0]) }; continue }
      const full = path.resolve(dir, pic.src)
      const ext = path.extname(full).toLowerCase()
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { problems.push(`card "${card.id}" shows "${pic.src}", but there is no file at ${full}`); continue }
      if (!MIME[ext]) { problems.push(`card "${card.id}" shows "${pic.src}", which is not a type Clinder can show (pictures: png, jpg, gif, webp, svg, avif; recordings: mp4, webm)`); continue }
      const buf = fs.readFileSync(full)
      const [w, h] = imageSize(buf) || [0, 0]
      bytes += buf.length
      files.push(full)
      images[pic.src] = { url: embed ? `data:${MIME[ext]};base64,${buf.toString('base64')}` : `pic/${files.length - 1}`, w, h, video: isVideo(full) }
    }
    // A demo page: a web address stays a link; a local .html page goes inside a one-file review,
    // or is handed out by the local server from the deck's folder.
    const src = card.demo?.src
    if (src && !demos[src]) {
      if (/^https?:/i.test(src)) { demos[src] = { url: src }; continue }
      const full = path.resolve(dir, src)
      const ext = path.extname(full).toLowerCase()
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) problems.push(`card "${card.id}" has the demo "${src}", but there is no file at ${full}`)
      else if (ext !== '.html' && ext !== '.htm') problems.push(`card "${card.id}" has the demo "${src}", which is not an .html page`)
      else if (!embed && !full.startsWith(dir + path.sep)) problems.push(`card "${card.id}" has the demo "${src}" outside the deck's folder; move it next to cards.json so the local server can hand it out`)
      else demos[src] = embed ? { html: fs.readFileSync(full, 'utf8') } : { url: 'files/' + path.relative(dir, full).split(path.sep).map(encodeURIComponent).join('/') }
    }
  }
  if (problems.length) throw new DeckError(file, problems)

  const source = fs.readFileSync(file, 'utf8')
  const payload = {
    ...deck,
    images,
    demos,
    mode: embed ? 'file' : 'serve',
    // Answers are remembered per deck in the browser. The key changes when the deck's title or cards change.
    key: 'clinder:' + hash(deck.title + '\n' + deck.cards.map((c) => c.id).join('\n')),
    version: hash(source),
    token, // only in server mode: proves an answer came from this page and not from another website
  }
  const html = fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace('<title>Clinder</title>', () => `<title>${escapeHtml(deck.title)}</title>`)
    .replace('data-theme="auto"', () => `data-theme="${deck.theme}"`)
    .replace('/*FONT*/', fontFace)
    .replace('/*DECK*/', () => `window.__DECK = ${scriptSafe(payload)};`)
  return { html, payload, deck, file, dir, files, bytes, version: payload.version }
}
