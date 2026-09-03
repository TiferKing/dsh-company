/**
 * Deterministic charter outline parser (Host-authoritative).
 *
 * The charter remains a single editable text document (drafted by the AI or
 * human, edited through formation/governance flows). The Host parses it into
 * a structured clause tree once per snapshot build so the Web view renders
 * without guessing. One convention, no heuristics:
 *
 * 1. `1.` / `1.2.3` numbered markers and `#`/`##` headers define the outline
 *    level from the marker alone; leading indentation never changes it.
 * 2. `-` / `*` bullets carry no marker depth, so they nest by indentation
 *    directly under the most recent numbered/header clause.
 * 3. Unmarked prose is body text of the most recent clause — it never becomes
 *    a sibling card. Prose before any clause becomes a flat preamble card.
 * 4. Paired `**bold**` wrapping is stripped from prose and titles.
 */

export interface CharterClause {
  /** Numeric marker verbatim (`1`, `1.2`); absent for headers, bullets, preamble. */
  number?: string
  title: string
  body: string[]
  children: CharterClause[]
}

const CHARTER_HEADER = /^(#{1,6})\s+(.+)$/u
const CHARTER_NUMBERED = /^(\d+(?:\.\d+)*)[.)]?\s+(.+)$/u
const CHARTER_BULLET = /^[-*]\s+(.+)$/u
const CHARTER_BOLD = /^\*\*(.+)\*\*$/u

const MAX_CLAUSE_DEPTH = 8

function stripBold(value: string): string {
  const match = CHARTER_BOLD.exec(value)
  return match === null ? value : (match[1] ?? value).trim()
}

export function parseCharterClauses(charter: string): CharterClause[] {
  const roots: CharterClause[] = []
  const stack: Array<{ level: number; node: CharterClause }> = []
  let structuralLevel = -1
  let lastMarkerNode: CharterClause | undefined

  const attach = (node: CharterClause, level: number): void => {
    while (stack.length > 0 && (stack.at(-1)?.level ?? -1) >= level) stack.pop()
    const parent = stack.at(-1)?.node
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    stack.push({ level, node })
  }

  for (const source of charter.split(/\r?\n/u)) {
    if (source.trim() === '') continue
    const indent = source.match(/^\s*/u)?.[0].replace(/\t/gu, '  ').length ?? 0
    const line = source.trim()

    const header = CHARTER_HEADER.exec(line)
    const numbered = header === null ? CHARTER_NUMBERED.exec(line) : null
    const bold = header === null && numbered === null ? CHARTER_BOLD.exec(line) : null
    const bullet = header === null && numbered === null && bold === null ? CHARTER_BULLET.exec(line) : null

    if (numbered !== null) {
      const marker = numbered[1] ?? '1'
      const level = Math.min(MAX_CLAUSE_DEPTH, marker.split('.').length - 1)
      const node: CharterClause = { number: marker, title: stripBold((numbered[2] ?? '').trim()), body: [], children: [] }
      attach(node, level)
      structuralLevel = level
      lastMarkerNode = node
      continue
    }
    if (header !== null) {
      const level = Math.min(MAX_CLAUSE_DEPTH, (header[1] ?? '#').length - 1)
      const node: CharterClause = { title: stripBold((header[2] ?? '').trim()), body: [], children: [] }
      attach(node, level)
      structuralLevel = level
      lastMarkerNode = node
      continue
    }
    if (bullet !== null) {
      const level = Math.min(MAX_CLAUSE_DEPTH, Math.max(0, structuralLevel + 1 + Math.floor(indent / 2)))
      const node: CharterClause = { title: stripBold((bullet[1] ?? '').trim()), body: [], children: [] }
      attach(node, level)
      lastMarkerNode = node
      continue
    }
    const text = stripBold(bold !== null ? (bold[1] ?? '').trim() : line)
    // Prose is body of the most recent clause; before any clause exists it
    // degrades to a flat preamble card instead of inventing hierarchy.
    if (lastMarkerNode !== undefined) lastMarkerNode.body.push(text)
    else attach({ title: text, body: [], children: [] }, 0)
  }
  return roots
}
