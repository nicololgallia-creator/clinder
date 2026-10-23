// Reads a deck file (cards.json), checks it, and returns a clean, predictable shape.
// Problems are collected and reported together, each with the card it belongs to.
import fs from 'node:fs'
import path from 'node:path'

const TONES = ['green', 'gold', 'red', 'ink', 'plain']

// Straight quotes become curly ones in text people read. Ids, kinds and paths are left alone.
// A single quote after a space or bracket opens (‘); every other one closes or is an apostrophe (’).
const curly = (t) => (typeof t === 'string' ? t.replace(/"([^"\n]*)"/g, '“$1”').replace(/(^|[\s([{“])'/g, '$1‘').replace(/'/g, '’') : t)

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const MAX_CODE = 20000 // characters per text block; longer output belongs in a linked file

// "shots\login.png" written on Windows must still work on a Mac or Linux. Web addresses are left alone.
const localPath = (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^data:/i.test(p) ? p : p.replace(/\\/g, '/'))
const isText = (v) => typeof v === 'string' && v.trim() !== ''

export class DeckError extends Error {
  constructor(file, problems) {
    super(`${file} has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` + problems.map((p) => '  - ' + p).join('\n'))
    this.problems = problems
  }
}

// Finds the deck file: a path to a .json file, or a folder that holds cards.json.
export function resolveDeckPath(input = '.') {
  const full = path.resolve(input)
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return path.join(full, 'cards.json')
  return full
}

export function loadDeck(input) {
  const file = resolveDeckPath(input)
  if (!fs.existsSync(file)) throw new Error(`No deck found at ${file}. Run "clinder init" to make one.`)
  let raw
  try {
    // Windows tools such as PowerShell often start a UTF-8 file with an invisible byte-order mark. JSON.parse refuses it.
    const text = fs.readFileSync(file, 'utf8')
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`)
  }
  const deck = normalizeDeck(Array.isArray(raw) ? { cards: raw } : raw, file)
  return { deck, file, dir: path.dirname(file) }
}

export function normalizeDeck(raw, file = 'cards.json') {
  const problems = []
  if (!raw || typeof raw !== 'object') throw new DeckError(file, ['the file must hold an object with a "cards" list'])
  if (!Array.isArray(raw.cards)) throw new DeckError(file, ['there is no "cards" list'])
  if (raw.cards.length === 0) problems.push('"cards" is empty, so there is nothing to review')

  // Kinds are the coloured labels. A kind a card uses but the deck does not define still works: its name becomes the label.
  const kinds = {}
  const addKind = (key, value) => {
    const tone = typeof value === 'object' && TONES.includes(value?.tone) ? value.tone : TONES[Object.keys(kinds).length] || 'plain'
    const label = typeof value === 'object' ? value?.label : value
    kinds[key] = { label: curly(isText(label) ? label : key), tone }
  }
  if (raw.kinds && typeof raw.kinds === 'object') for (const [k, v] of Object.entries(raw.kinds)) addKind(k, v)

  const seen = new Set()
  const cards = raw.cards.map((c, n) => {
    const where = `card ${n + 1}${c && isText(c.id) ? ` ("${c.id}")` : ''}`
    if (!c || typeof c !== 'object') { problems.push(`${where} is not an object`); return null }
    // Older swipe-review decks used other names for the same fields.
    const id = c.id
    const summary = c.summary ?? c.changed ?? c.description
    const images = c.images ?? c.media ?? c.imgs
    if (!isText(id)) problems.push(`${where} needs an "id" (a short unique name, like "login-fix")`)
    else if (seen.has(id)) problems.push(`${where} uses the id "${id}" twice; every card needs its own`)
    else seen.add(id)
    if (!isText(c.title)) problems.push(`${where} needs a "title"`)
    if (c.kind != null && !isText(c.kind)) problems.push(`${where} has a "kind" that is not text`)
    if (isText(c.kind) && !kinds[c.kind]) addKind(c.kind, c.kind)

    const paragraphs = asList(summary).flatMap((p) => (typeof p === 'string' ? p.split(/\n\s*\n/) : [])).map((p) => p.trim()).filter(Boolean)

    const pics = asList(images).map((im, k) => {
      const pic = Array.isArray(im) ? { src: im[0], caption: im[1] } : typeof im === 'string' ? { src: im } : im || {}
      if (!isText(pic.src)) { problems.push(`${where}, picture ${k + 1} needs a "src" (a path to the image file)`); return null }
      return { src: localPath(pic.src), caption: curly(isText(pic.caption) ? pic.caption : '') }
    }).filter(Boolean)

    // Text output for work with nothing to photograph: a test run, a terminal session, a diff, a log.
    const code = asList(c.code).map((block) => {
      const b = typeof block === 'string' ? { text: block } : block || {}
      if (typeof b.text !== 'string' || !b.text.trim()) return null
      const text = b.text.length > MAX_CODE ? b.text.slice(0, MAX_CODE) + `\n… (${b.text.length - MAX_CODE} more characters cut)` : b.text
      return { caption: curly(isText(b.caption) ? b.caption : ''), text }
    }).filter(Boolean)

    const links = asList(c.links).map((l, k) => {
      const link = typeof l === 'string' ? { href: l, text: l } : l || {}
      if (!isText(link.href)) { problems.push(`${where}, link ${k + 1} needs an "href"`); return null }
      return { href: link.href, text: curly(isText(link.text) ? link.text : link.href) }
    }).filter(Boolean)

    // A demo is a page the reviewer can click through inside the card: an .html file next to the deck, or a web address.
    let demo = null
    if (c.demo != null) {
      const d = typeof c.demo === 'string' ? { src: c.demo } : c.demo
      if (!d || !isText(d.src)) problems.push(`${where} has a "demo" without a "src" (an .html file next to the deck, or a web address)`)
      else demo = { src: localPath(d.src), caption: curly(isText(d.caption) ? d.caption : ''), height: Number.isFinite(d.height) ? Math.max(240, Math.min(1200, Math.round(d.height))) : 520 }
    }

    return {
      id: isText(id) ? id : `card-${n + 1}`,
      label: curly(isText(c.label ?? c.nums) ? c.label ?? c.nums : ''),
      kind: isText(c.kind) ? c.kind : '',
      title: curly(isText(c.title) ? c.title : ''),
      by: curly(isText(c.by) ? c.by : ''),
      summary: paragraphs.map(curly),
      look: curly(isText(c.look) ? c.look : ''),
      steps: asList(c.steps ?? c.phone).filter(isText).map(curly),
      ask: curly(isText(c.ask ?? c.call) ? c.ask ?? c.call : ''),
      flags: asList(c.flags).filter(isText).map(curly),
      images: pics,
      demo,
      code,
      links,
    }
  }).filter(Boolean)

  if (problems.length) throw new DeckError(file, problems)
  const theme = ['light', 'dark'].includes(raw.theme) ? raw.theme : 'auto'
  return { title: curly(isText(raw.title) ? raw.title : 'Review'), theme, kinds, cards }
}
