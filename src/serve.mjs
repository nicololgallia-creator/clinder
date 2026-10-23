// A small local server for reviewing a deck while agents are still working.
// It rebuilds the page from cards.json on every visit, notices when the deck changes,
// and saves each answer to answers.json next to the deck, where an agent can read it.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { buildPage } from './build.mjs'
import { resolveDeckPath } from './deck.mjs'
import { MIME } from './images.mjs'

export const answersPathFor = (deckFile) => path.join(path.dirname(deckFile), 'answers.json')

// Types for files a card links to or shows as a demo, so the browser opens them instead of downloading them.
const PAGE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
}

export function readAnswers(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data.answers === 'object' && data.answers) return data
  } catch { /* no file yet, or a broken one: start fresh */ }
  return { answers: {} }
}

// Write to a temporary file first, so an agent reading at the same moment never sees half a file.
function writeAnswers(file, data) {
  const text = JSON.stringify(data, null, 2) + '\n'
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(file, text) // Windows refuses the rename while another program has the file open
  }
}

export function openBrowser(url) {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', `start "" "${url}"`], { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* no browser to open; the address is printed anyway */ }
}

export function serve(input, { port = 4848, open = true, answers, quiet = false } = {}) {
  const deckFile = resolveDeckPath(input)
  const answersFile = path.resolve(answers || answersPathFor(deckFile))
  const token = crypto.randomBytes(16).toString('hex')
  const log = quiet ? () => {} : (...a) => console.log(...a)

  // The first build must work, or there is nothing to show. Later, a broken edit keeps the last good deck on screen.
  let latest = buildPage(deckFile, { embed: false, token })
  let lastError = ''
  const rebuild = () => {
    try {
      latest = buildPage(deckFile, { embed: false, token })
      if (lastError) log('The deck is readable again.')
      lastError = ''
    } catch (err) {
      if (err.message !== lastError) log(`\nThe deck has a problem, so the page keeps showing the last good version:\n${err.message}\n`)
      lastError = err.message
    }
    return latest
  }

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }
  const sendFile = (res, full, extra, req) => {
    const type = MIME[path.extname(full).toLowerCase()] || PAGE_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
    fs.readFile(full, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain')
      // Browsers fetch recordings in pieces (Safari will not play a video any other way).
      const range = req && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1
        if (start > end || start >= buf.length) { res.writeHead(416, { 'content-range': `bytes */${buf.length}` }); return res.end() }
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${buf.length}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
        return res.end(buf.subarray(start, end + 1))
      }
      send(res, 200, buf, type, { 'accept-ranges': 'bytes', ...extra })
    })
  }
  // Files from the deck's folder (demo pages, linked notes) are treated as strangers: the browser runs them
  // sandboxed, so even opened on their own they cannot reach the review page or its answers.
  const SANDBOXED = { 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals' }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 100_000) { reject(new Error('too large')); req.destroy() }
      })
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (err) { reject(err) } })
    })

  const server = http.createServer(async (req, res) => {
    // Only answer requests addressed to this machine by name. This blocks websites that rename themselves to 127.0.0.1.
    const host = (req.headers.host || '').replace(/:\d+$/, '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, 'Forbidden', 'text/plain')
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, rebuild().html, 'text/html; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/deck') return send(res, 200, rebuild().payload)
      if (req.method === 'GET' && url.pathname === '/answers') return send(res, 200, readAnswers(answersFile))

      if (req.method === 'POST' && url.pathname === '/answers') {
        // A custom header plus a secret only this page knows: other websites cannot save answers.
        if (req.headers['x-clinder-token'] !== token) return send(res, 403, { error: 'This page is out of date. Reload it.' })
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id || id.length > 200) return send(res, 400, { error: 'An answer needs a card id.' })
        const data = readAnswers(answersFile)
        if (body.verdict === null) delete data.answers[id]
        else if (body.verdict === 'yes' || body.verdict === 'no') {
          data.answers[id] = { verdict: body.verdict, note: String(body.note || '').slice(0, 10_000), at: typeof body.at === 'string' ? body.at : new Date().toISOString() }
        } else return send(res, 400, { error: 'The verdict must be "yes", "no" or null.' })
        const titles = Object.fromEntries(latest.deck.cards.map((c) => [c.id, c.title]))
        if (titles[id] && data.answers[id]) data.answers[id].title = titles[id]
        const out = { deck: latest.deck.title, updated: new Date().toISOString(), answers: data.answers }
        writeAnswers(answersFile, out)
        return send(res, 200, out)
      }

      if (req.method === 'GET' && parts[0] === 'pic' && parts.length === 2) {
        const full = latest.files[Number(parts[1])]
        return full ? sendFile(res, full, {}, req) : send(res, 404, 'Not found', 'text/plain')
      }
      // Links on cards can point at files next to the deck. Nothing outside the deck's folder is served.
      if (req.method === 'GET' && parts[0] === 'files' && parts.length > 1) {
        const root = path.dirname(deckFile)
        const full = path.resolve(root, ...parts.slice(1).map(decodeURIComponent))
        if (!full.startsWith(root + path.sep) || full === answersFile) return send(res, 404, 'Not found', 'text/plain')
        return fs.stat(full, (err, st) => (err || !st.isFile() ? send(res, 404, 'Not found', 'text/plain') : sendFile(res, full, SANDBOXED, req)))
      }
      send(res, 404, 'Not found', 'text/plain')
    } catch (err) {
      send(res, 500, { error: String(err.message || err) })
    }
  })

  return new Promise((resolve, reject) => {
    let tries = 0
    const listen = (p) => server.listen(p, '127.0.0.1')
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries++ < 20) listen(port + tries)
      else reject(err)
    })
    server.on('listening', () => {
      // The address it listens on. "localhost" can resolve to IPv6 first, which Node 18's fetch does not fall back from.
      const url = `http://127.0.0.1:${server.address().port}`
      log(`\n  ${latest.deck.title}: ${latest.deck.cards.length} card${latest.deck.cards.length === 1 ? '' : 's'}`)
      log(`  Review at  ${url}`)
      log(`  Answers go to  ${answersFile}`)
      log(`  Press Ctrl+C to stop.\n`)
      if (open) openBrowser(url)
      resolve({ server, url, answersFile, close: () => new Promise((r) => server.close(r)) })
    })
    listen(port)
  })
}
