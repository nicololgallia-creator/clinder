#!/usr/bin/env node
// Clinder: swipe through work your AI agents finished, then hand your answers back to them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPage } from '../src/build.mjs'
import { serve, answersPathFor } from '../src/serve.mjs'
import { loadDeck, resolveDeckPath } from '../src/deck.mjs'
import { readAnswersFile, summarize, summaryText } from '../src/answers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const HELP = `Clinder ${version}: swipe through work your AI agents finished.

Usage
  clinder serve [deck]         review in the browser; answers are saved to answers.json next to the deck
  clinder serve [deck] --wait  the same, then print the answers and stop once every card is answered
  clinder build [deck]         make one self-contained HTML file you can send to anyone
  clinder answers [deck]       print the answers so far: sent back (with notes), approved, waiting
  clinder init [folder]        start a new deck with two example cards
  clinder install-skill        teach Claude Code the "use clinder" keyword (copies the skill to ~/.claude/skills)

  [deck] is a cards.json file, or a folder that has one. The default is the current folder.

Options
  --port <n>          serve: the port to use (default 4848; the next free one if it is taken)
  --no-open           serve: do not open a browser
  --wait              serve: stop once every card is answered, and print the answers
  --timeout <minutes> serve --wait: give up after this long (default: wait as long as it takes)
  --answers <file>    serve and answers: where answers are saved (default: answers.json next to the deck)
  --json              answers and serve --wait: print the answers as JSON
  --out <file>        build: where to write the page (default: review.html next to the deck)
  --project           install-skill: install into this project's .claude/skills instead of your home folder
  --print             install-skill: print instructions to paste into any other agent's rules instead
  -h, --help          show this help
  -v, --version       show the version

Docs: https://github.com/nicololgallia-creator/clinder`

const VALUED = ['--port', '--out', '--answers', '--timeout']
const FLAGS = { '--no-open': ['open', false], '--wait': ['wait', true], '--json': ['json', true], '--project': ['project', true], '--print': ['print', true] }

function parse(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else if (FLAGS[a]) opts[FLAGS[a][0]] = FLAGS[a][1]
    else if (VALUED.includes(a)) {
      if (argv[i + 1] == null) fail(`${a} needs a value`)
      opts[a.slice(2)] = argv[++i]
    } else if (a.startsWith('--')) fail(`Unknown option ${a}. Run "clinder --help" to see the options.`)
    else opts._.push(a)
  }
  return opts
}

// How the person ran Clinder, so the next command we suggest works for them as typed.
function self() {
  if (process.env.npm_command === 'exec') return 'npx github:nicololgallia-creator/clinder'
  const script = process.argv[1] || ''
  if (/node_modules/.test(script)) return 'clinder'
  const near = path.relative(process.cwd(), script)
  return 'node ' + (near && !near.startsWith('..') ? near : script)
}

function fail(message, code = 1) {
  console.error(`\n  ${message.split('\n').join('\n  ')}\n`)
  process.exit(code)
}

function init(folder = 'review') {
  const dir = path.resolve(folder)
  const file = path.join(dir, 'cards.json')
  if (fs.existsSync(file)) fail(`${file} already exists. Pick another folder, or edit that one.`)
  fs.mkdirSync(dir, { recursive: true })
  const starter = {
    $schema: 'https://raw.githubusercontent.com/nicololgallia-creator/clinder/main/cards.schema.json',
    title: 'My review',
    kinds: { done: 'Done', decide: 'Needs a decision' },
    cards: [
      {
        id: 'first-card',
        kind: 'done',
        title: 'An example card',
        by: 'Agent 1',
        summary: [
          'Say what changed in two or three short sentences, in plain words, for someone who did not watch the work happen.',
          'A blank line, or a new item in this list, starts a new paragraph.',
        ],
        look: 'Tell the reviewer what to look at in the pictures.',
        flags: ['Use heads-ups for anything unfinished or unchecked.'],
        images: [],
      },
      {
        id: 'second-card',
        kind: 'decide',
        title: 'A card that needs a decision',
        summary: ['Describe the two options, then ask.'],
        ask: 'Option A or option B?',
      },
    ],
  }
  fs.writeFileSync(file, JSON.stringify(starter, null, 2) + '\n')
  const where = path.relative(process.cwd(), dir) || '.'
  console.log(`\n  Made ${file}\n\n  Next:\n    1. Edit the cards, and put screenshots in ${where} (list them under "images").\n    2. ${self()} serve ${where}\n`)
}

function build(input, out) {
  const { html, file, deck, bytes } = buildPage(input, { embed: true })
  const target = path.resolve(out || path.join(path.dirname(file), 'review.html'))
  fs.writeFileSync(target, html)
  const mb = (Buffer.byteLength(html) / 1048576).toFixed(2)
  console.log(`\n  ${deck.cards.length} card${deck.cards.length === 1 ? '' : 's'}, ${mb} MB -> ${target}`)
  if (bytes > 25 * 1048576) console.log('  That is a big file. Smaller screenshots (JPEG or WebP, about 1000 pixels wide) and short recordings load much faster.')
  console.log('  Open it in any browser. Answers stay in that browser until you press "Download answers" or "Copy my notes".\n')
}

function printAnswers(input, { json, answers }) {
  const deckFile = resolveDeckPath(input)
  const { deck } = loadDeck(deckFile)
  const s = summarize(deck, readAnswersFile(path.resolve(answers || answersPathFor(deckFile))))
  console.log(json ? JSON.stringify(s, null, 2) : summaryText(s))
  return s
}

async function serveAndWait(input, opts) {
  const deckFile = resolveDeckPath(input)
  const port = opts.port == null ? 4848 : Number(opts.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be a number from 1 to 65535')
  const app = await serve(deckFile, { port, open: opts.open !== false, answers: opts.answers, quiet: !!(opts.wait && opts.json) })
  if (!opts.wait) return
  const minutes = opts.timeout == null ? 0 : Number(opts.timeout)
  if (!(minutes >= 0)) fail('--timeout must be a number of minutes')
  if (!opts.json) console.log('  Waiting until every card is answered…\n')
  const started = Date.now()
  const check = () => {
    let s
    try { s = summarize(loadDeck(deckFile).deck, readAnswersFile(app.answersFile)) } catch { return } // the deck is mid-edit; look again
    const timedOut = minutes > 0 && Date.now() - started > minutes * 60000
    if (!s.done && !timedOut) return
    clearInterval(timer)
    console.log(opts.json ? JSON.stringify(s, null, 2) : (timedOut ? `Stopped waiting after ${minutes} minute${minutes === 1 ? '' : 's'}.\n\n` : '') + summaryText(s) + `\n\nAnswers file: ${app.answersFile}`)
    // Leave the page up a moment so the reviewer sees the finish screen, then stop.
    setTimeout(() => app.close().then(() => process.exit(s.done ? 0 : 2)), 2500)
  }
  const timer = setInterval(check, 1000)
}

function installSkill({ project, print }) {
  const skill = path.join(root, 'skills', 'clinder', 'SKILL.md')
  if (print) {
    console.log(fs.readFileSync(path.join(root, 'skills', 'clinder', 'for-other-agents.md'), 'utf8'))
    return
  }
  const base = project ? path.resolve('.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills')
  const dir = path.join(base, 'clinder')
  const target = path.join(dir, 'SKILL.md')
  const existed = fs.existsSync(target)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(skill, target)
  console.log(`\n  ${existed ? 'Updated' : 'Installed'} the Clinder skill at ${target}`)
  console.log('  In Claude Code, say "use clinder" in a request, and the finished work opens as a Clinder review.')
  console.log(`  Other agents: run "${self()} install-skill --print" and paste the result into their rules file.\n`)
}

const opts = parse(process.argv.slice(2))
const [command, target] = opts._
try {
  if (opts.version) console.log(version)
  else if (opts.help || !command) console.log(HELP)
  else if (command === 'init') init(target)
  else if (command === 'build') build(target, opts.out)
  else if (command === 'serve') await serveAndWait(target, opts)
  else if (command === 'answers') printAnswers(target, opts)
  else if (command === 'install-skill') installSkill(opts)
  else fail(`Unknown command "${command}". Run "clinder --help" to see the commands.`)
} catch (err) {
  fail(err.message)
}
