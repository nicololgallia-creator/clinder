// Turns answers.json into what an agent needs: what was approved, what was sent back (with the notes), what is still waiting.
import fs from 'node:fs'

export function readAnswersFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data.answers === 'object' && data.answers) return data
  } catch { /* no answers yet */ }
  return { answers: {} }
}

export function summarize(deck, data) {
  const answers = (data && data.answers) || {}
  const out = { deck: deck.title, total: deck.cards.length, approved: [], sentBack: [], waiting: [] }
  for (const c of deck.cards) {
    const a = answers[c.id]
    if (!a) out.waiting.push({ id: c.id, title: c.title })
    else if (a.verdict === 'yes') out.approved.push({ id: c.id, title: c.title })
    else out.sentBack.push({ id: c.id, title: c.title, note: a.note || '' })
  }
  out.answered = out.total - out.waiting.length
  out.done = out.waiting.length === 0
  return out
}

export function summaryText(s) {
  const lines = [`${s.deck}: ${s.answered} of ${s.total} answered.`, '']
  lines.push(`SENT BACK (${s.sentBack.length})`)
  for (const c of s.sentBack) lines.push(`- ${c.title} [${c.id}]: ${c.note || '(no note)'}`)
  lines.push('', `APPROVED (${s.approved.length})`)
  for (const c of s.approved) lines.push(`- ${c.title} [${c.id}]`)
  if (s.waiting.length) {
    lines.push('', `NOT ANSWERED YET (${s.waiting.length})`)
    for (const c of s.waiting) lines.push(`- ${c.title} [${c.id}]`)
  }
  return lines.join('\n')
}
