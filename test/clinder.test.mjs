// Run with: npm test   (Node's own test runner, nothing to install)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { imageSize } from '../src/images.mjs'
import { normalizeDeck, DeckError } from '../src/deck.mjs'
import { buildPage, scriptSafe } from '../src/build.mjs'
import { serve } from '../src/serve.mjs'
import { summarize, summaryText } from '../src/answers.mjs'
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'clinder.mjs')
const demo = path.join(root, 'examples', 'demo')

// An empty temp folder that is deleted when the test ends.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinder-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A fresh copy of the demo deck, so tests never write into the repo.
function demoCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinder-test-'))
  fs.cpSync(demo, dir, { recursive: true })
  fs.rmSync(path.join(dir, 'answers.json'), { force: true }) // answers from trying the demo must not leak into a test
  return dir
}

test('reads picture sizes from PNG, JPEG, GIF and WebP headers', () => {
  const png = fs.readFileSync(path.join(demo, 'screenshots', 'weekly-chart.png'))
  const [w, h] = imageSize(png)
  assert.ok(w > 0 && h > 0)

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(jpeg), [600, 300])

  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(20)])
  assert.deepEqual(imageSize(gif), [320, 240])

  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12)
  webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3)
  assert.deepEqual(imageSize(webp), [800, 600])

  assert.equal(imageSize(Buffer.from('definitely not a picture, just some text')), null)
})

test('a deck is checked, and every problem is reported at once', () => {
  assert.throws(
    () => normalizeDeck({ cards: [{ id: 'a', title: 'One' }, { id: 'a' }, { title: 'Three', images: [{}] }] }),
    (err) => err instanceof DeckError && err.problems.length === 4,
  )
  assert.throws(() => normalizeDeck({ title: 'No cards' }), DeckError)
})

test('older swipe-review decks still work', () => {
  const deck = normalizeDeck({
    cards: [{ id: 'x', nums: '#7', title: 'Old', changed: ['First.', 'Second.'], call: 'A or B?', phone: ['Open it'], imgs: [['shot.png', 'A shot']] }],
  })
  const c = deck.cards[0]
  assert.equal(c.label, '#7')
  assert.deepEqual(c.summary, ['First.', 'Second.'])
  assert.equal(c.ask, 'A or B?')
  assert.deepEqual(c.steps, ['Open it'])
  assert.deepEqual(c.images, [{ src: 'shot.png', caption: 'A shot' }])
})

test('text gets curly quotes, but ids, paths and links stay exact', () => {
  const deck = normalizeDeck({
    cards: [{ id: "it's-fine", title: 'The "new" page isn\'t done', summary: 'One.\n\nTwo.', images: ["it's.png"], links: ["https://example.com/?q='a'"] }],
  })
  const c = deck.cards[0]
  assert.equal(c.title, 'The “new” page isn’t done')
  assert.equal(c.id, "it's-fine")
  assert.equal(c.images[0].src, "it's.png")
  assert.equal(c.links[0].href, "https://example.com/?q='a'")
  assert.deepEqual(c.summary, ['One.', 'Two.'])
})

test('kinds a deck does not define still get a label and a colour', () => {
  const deck = normalizeDeck({ kinds: { done: 'Done' }, cards: [{ id: 'a', title: 'A', kind: 'done' }, { id: 'b', title: 'B', kind: 'risky' }] })
  assert.deepEqual(deck.kinds.done, { label: 'Done', tone: 'green' })
  assert.deepEqual(deck.kinds.risky, { label: 'risky', tone: 'gold' })
})

test('card text can never close the script tag early', (t) => {
  const safe = scriptSafe({ t: '</script><script>alert(1)</script>' })
  assert.ok(!safe.includes('<'))
  assert.equal(JSON.parse(safe).t, '</script><script>alert(1)</script>')

  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ title: '</title><b>x', cards: [{ id: 'a', title: '</script><img src=x onerror=alert(1)>' }] }))
  const { html } = buildPage(dir)
  assert.equal(html.split('</script>').length - 1, 2, 'only the page’s own two script tags close')
  assert.ok(html.includes('<title>&lt;/title&gt;&lt;b&gt;x</title>'))
})

test('build puts every picture inside the page', () => {
  const { html, payload, deck } = buildPage(demo)
  assert.equal(deck.cards.length, 4)
  assert.equal(payload.mode, 'file')
  const pics = Object.values(payload.images)
  assert.equal(pics.length, 3)
  for (const p of pics) {
    assert.match(p.url, /^data:image\/png;base64,/)
    assert.ok(p.w > 0 && p.h > 0)
  }
  assert.ok(html.length > 300_000)
})

test('the page loads nothing from the internet: the font is built in', () => {
  const { html } = buildPage(demo)
  assert.match(html, /@font-face \{ font-family: "Jersey 15";[^}]*url\(data:font\/woff2;base64,/)
  assert.match(html, /@font-face \{ font-family: "Atkinson Hyperlegible"; font-style: normal; font-weight: 700;[^}]*url\(data:font\/woff2;base64,/)
  assert.ok(!html.includes('/*FONT*/'))
  // the only web address allowed is the plain link in the credit, which loads nothing by itself
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']?(https?:[^"'\s>]+)/g)].map((m) => m[1])
  assert.deepEqual(external.filter((url) => url !== 'https://galliainc.com'), [])
  assert.ok(!/@import|fonts\.googleapis|<link[^>]+stylesheet/.test(html))
})

test('a click-through demo goes inside a one-file review, and web addresses stay links', (t) => {
  const { payload } = buildPage(demo)
  assert.match(payload.demos['prototypes/settings.html'].html, /<button class="t" role="switch"/)
  const card = payload.cards.find((c) => c.id === 'dark-mode-default')
  assert.deepEqual(card.demo, { src: 'prototypes/settings.html', caption: 'The new settings page. The switches work, but nothing is saved yet.', height: 460 })

  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'a', title: 'A', demo: 'https://example.com/app' }] }))
  assert.deepEqual(buildPage(dir).payload.demos, { 'https://example.com/app': { url: 'https://example.com/app' } })
})

test('a demo that is missing or not a page is reported', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'just text')
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'gone', title: 'A', demo: 'gone.html' }, { id: 'text', title: 'B', demo: { src: 'notes.txt' } }, { id: 'empty', title: 'C', demo: {} }] }))
  assert.throws(() => buildPage(dir), (err) => err.problems.length === 1 && /needs|without a "src"/.test(err.problems[0]))
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'gone', title: 'A', demo: 'gone.html' }, { id: 'text', title: 'B', demo: { src: 'notes.txt' } }] }))
  assert.throws(() => buildPage(dir), (err) => err.problems.length === 2 && /no file/.test(err.problems[0]) && /not an \.html page/.test(err.problems[1]))
})

test('a missing picture is reported with the card it belongs to', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'login', title: 'Login', images: ['gone.png'] }] }))
  assert.throws(() => buildPage(dir), /card "login" shows "gone.png"/)
})

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('the local server saves answers where an agent can read them, and only from its own page', async () => {
  const dir = demoCopy()
  const app = await serve(dir, { port: 0, open: false, quiet: true })
  try {
    const page = await request(app.url + '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /Fieldnote, Thursday’s agent run/)

    const deck = JSON.parse((await request(app.url + '/deck')).body)
    assert.equal(deck.mode, 'serve')
    assert.match(deck.images['screenshots/pricing-plans.png'].url, /^pic\/\d+$/)

    const pic = await request(`${app.url}/${deck.images['screenshots/pricing-plans.png'].url}`)
    assert.equal(pic.status, 200)
    assert.equal(pic.type, 'image/png')

    const answer = JSON.stringify({ id: 'pricing-page', verdict: 'no', note: 'Make the Team button bigger.', at: '2026-10-23T12:00:00.000Z' })
    const noToken = await request(app.url + '/answers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: answer })
    assert.equal(noToken.status, 403, 'a save without the page’s token is refused')

    const saved = await request(app.url + '/answers', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clinder-token': deck.token }, body: answer })
    assert.equal(saved.status, 200)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'))
    assert.deepEqual(file.answers['pricing-page'], { verdict: 'no', note: 'Make the Team button bigger.', at: '2026-10-23T12:00:00.000Z', title: 'New pricing page with two plans' })

    const cleared = await request(app.url + '/answers', { method: 'POST', headers: { 'x-clinder-token': deck.token }, body: JSON.stringify({ id: 'pricing-page', verdict: null }) })
    assert.equal(cleared.status, 200)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8')).answers, {})

    const bad = await request(app.url + '/answers', { method: 'POST', headers: { 'x-clinder-token': deck.token }, body: JSON.stringify({ id: 'x', verdict: 'maybe' }) })
    assert.equal(bad.status, 400)

    const otherHost = await request(app.url + '/answers', { headers: { host: 'evil.example' } })
    assert.equal(otherHost.status, 403, 'requests addressed to another name are refused')

    const linked = await request(app.url + '/files/files/notes.md')
    assert.equal(linked.status, 200)
    assert.match(linked.type, /^text\/plain/)

    assert.equal(deck.demos['prototypes/settings.html'].url, 'files/prototypes/settings.html')
    const demoPage = await new Promise((resolve) => http.get(app.url + '/files/prototypes/settings.html', (res) => { res.resume(); resolve(res) }))
    assert.equal(demoPage.statusCode, 200)
    assert.match(demoPage.headers['content-type'], /^text\/html/)
    assert.match(demoPage.headers['content-security-policy'], /^sandbox /, 'demo pages run sandboxed even when opened on their own')
    const outside = await request(app.url + '/files/..%2f..%2f..%2fwindows%2fwin.ini')
    assert.equal(outside.status, 404, 'nothing outside the deck folder is served')
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the server keeps the last good deck when an edit breaks it', async () => {
  const dir = demoCopy()
  const app = await serve(dir, { port: 0, open: false, quiet: true })
  try {
    const before = JSON.parse((await request(app.url + '/deck')).body)
    fs.writeFileSync(path.join(dir, 'cards.json'), '{ this is not json')
    const during = JSON.parse((await request(app.url + '/deck')).body)
    assert.equal(during.version, before.version)

    const fixed = JSON.parse(fs.readFileSync(path.join(demo, 'cards.json'), 'utf8'))
    fixed.cards.push({ id: 'late-card', title: 'A card that arrived late' })
    fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify(fixed))
    const after = JSON.parse((await request(app.url + '/deck')).body)
    assert.notEqual(after.version, before.version)
    assert.equal(after.cards.length, 5)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a deck saved by PowerShell (with a byte-order mark) still loads', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'cards.json'), String.fromCharCode(0xfeff) + JSON.stringify({ cards: [{ id: 'a', title: 'From Windows' }] }))
  assert.equal(buildPage(dir).deck.cards[0].title, 'From Windows')
})

test('Windows-style paths, spaces and odd names in picture paths work everywhere', (t) => {
  const dir = tempDir(t)
  fs.mkdirSync(path.join(dir, 'shots dir'))
  fs.copyFileSync(path.join(demo, 'screenshots', 'weekly-chart.png'), path.join(dir, 'shots dir', 'chart #1 (draft).png'))
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'a', title: 'A', images: ['shots dir' + String.fromCharCode(92) + 'chart #1 (draft).png'] }] }))
  const { payload } = buildPage(dir)
  assert.match(payload.images['shots dir/chart #1 (draft).png'].url, /^data:image\/png;base64,/)
})

test('screen recordings are shown, and marked as video', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'))
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ cards: [{ id: 'v', title: 'A recording', media: ['clip.mp4'] }] }))
  const pic = buildPage(dir).payload.images['clip.mp4']
  assert.equal(pic.video, true)
  assert.match(pic.url, /^data:video\/mp4;base64,/)
})

test('text output is kept as written, and very long output is cut with a note', () => {
  const long = 'x'.repeat(25000)
  const deck = normalizeDeck({ cards: [{ id: 'a', title: 'A', code: ['npm test\n  14 passing', { caption: 'Big log', text: long }] }] })
  const [first, second] = deck.cards[0].code
  assert.deepEqual(first, { caption: '', text: 'npm test\n  14 passing' })
  assert.equal(second.caption, 'Big log')
  assert.ok(second.text.length < long.length && /more characters cut/.test(second.text))
})

test('answers are summed up for an agent: sent back with notes, approved, waiting', () => {
  const deck = normalizeDeck({ title: 'T', cards: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] })
  const s = summarize(deck, { answers: { a: { verdict: 'yes' }, b: { verdict: 'no', note: 'Too small' } } })
  assert.deepEqual([s.answered, s.total, s.done], [2, 3, false])
  assert.deepEqual(s.sentBack, [{ id: 'b', title: 'B', note: 'Too small' }])
  assert.match(summaryText(s), /SENT BACK \(1\)\n- B \[b\]: Too small/)
  assert.match(summaryText(s), /NOT ANSWERED YET \(1\)\n- C \[c\]/)
})

test('clinder answers prints the answers so far', () => {
  const out = execFileSync(process.execPath, [cli, 'answers', demo, '--answers', path.join(os.tmpdir(), 'clinder-none.json'), '--json'], { encoding: 'utf8' })
  const s = JSON.parse(out)
  assert.deepEqual([s.total, s.answered, s.done], [4, 0, false])
})

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

test('serve --wait stops once every card is answered, and prints the answers', async (t) => {
  const dir = demoCopy()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const port = await freePort()
  const child = spawn(process.execPath, [cli, 'serve', dir, '--wait', '--json', '--no-open', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  const exited = new Promise((resolve) => child.on('exit', resolve))
  t.after(() => child.kill())
  const url = `http://localhost:${port}`
  let deck = null
  for (let i = 0; i < 50 && !deck; i++) {
    await new Promise((r) => setTimeout(r, 100))
    deck = await request(url + '/deck').then((r) => (r.status === 200 ? JSON.parse(r.body) : null), () => null)
  }
  assert.ok(deck, 'the server came up')
  for (const c of deck.cards) {
    const body = JSON.stringify({ id: c.id, verdict: c.id === 'weekly-chart' ? 'no' : 'yes', note: c.id === 'weekly-chart' ? 'Bar is clipped' : '' })
    await request(url + '/answers', { method: 'POST', headers: { 'x-clinder-token': deck.token }, body })
  }
  const code = await exited
  assert.equal(code, 0)
  const s = JSON.parse(out)
  assert.equal(s.done, true)
  assert.deepEqual(s.sentBack, [{ id: 'weekly-chart', title: 'Sign-ups chart in the weekly report', note: 'Bar is clipped' }])
})

test('install-skill puts the skill where Claude Code finds it, and --print gives other agents the same rules', (t) => {
  const dir = tempDir(t)
  execFileSync(process.execPath, [cli, 'install-skill', '--project'], { cwd: dir, encoding: 'utf8' })
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'clinder', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: clinder\ndescription: .*"use clinder"/m)
  const rules = execFileSync(process.execPath, [cli, 'install-skill', '--print'], { encoding: 'utf8' })
  assert.match(rules, /use clinder/)
  assert.match(rules, /serve \.clinder\/<short-name> --wait/)
})
