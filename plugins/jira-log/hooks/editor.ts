// A multi-line text box for the surfaces whose Input is one line: the text, where the cursor is in it,
// and the first visual row shown. Lines wrap at word boundaries to the box's width.
export type Editor = { text: string; cursor: number; top: number; isActive: boolean }

// A visual row: the text from `start` up to `end`, one line or the part of one that fits the width.
export type Row = { start: number; end: number }

export type EditorKey = { key: string; ctrl?: true; meta?: true }

// Rows the box shows before it scrolls, and the fewest it draws so it reads as a text area.
export const MIN_ROWS = 4
export const MAX_ROWS = 12
// Jira refuses a description over 32,767 characters.
const TEXT_LIMIT = 32_000

const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape',
])

export const editorOf = (text: string): Editor => ({ text, cursor: text.length, top: 0, isActive: false })

export function rowsOf(text: string, width: number): Row[] {
  const rows: Row[] = []
  let start = 0
  for (const line of text.split('\n')) {
    const end = start + line.length
    let from = start
    while (end - from > width) {
      const space = text.lastIndexOf(' ', from + width - 1)
      const cut = space > from ? space + 1 : from + width
      rows.push({ start: from, end: cut })
      from = cut
    }
    rows.push({ start: from, end })
    start = end + 1
  }

  return rows
}

// Where a wrapped row ends, the next row begins: a cursor there is drawn on the next row.
export function rowAt(rows: readonly Row[], cursor: number) {
  let at = 0
  rows.forEach((row, index) => {
    if (row.start <= cursor) at = index
  })

  return at
}

const lastIn = (rows: readonly Row[], index: number) => {
  const row = rows[index]
  if (row === undefined) return 0

  return rows[index + 1]?.start === row.end ? row.end - 1 : row.end
}

const cursorIn = (rows: readonly Row[], index: number, column: number) =>
  Math.min((rows[index]?.start ?? 0) + Math.max(0, column), lastIn(rows, index))

const insert = (editor: Editor, typed: string) => {
  const text = typed.replace(/\r\n?/g, '\n')
  const room = TEXT_LIMIT - editor.text.length
  if (room <= 0) return editor
  const added = text.slice(0, room)

  return {
    ...editor,
    text: editor.text.slice(0, editor.cursor) + added + editor.text.slice(editor.cursor),
    cursor: editor.cursor + added.length,
  }
}

// One key from the box: printable text (a paste comes as one string) is typed, Enter starts a new line.
function keyed(editor: Editor, { key, ctrl, meta }: EditorKey, width: number): Editor {
  const active = { ...editor, isActive: true }
  if (ctrl || meta) return active
  const { text, cursor } = active
  const rows = rowsOf(text, width)
  const row = rowAt(rows, cursor)
  const column = cursor - (rows[row]?.start ?? 0)
  switch (key) {
    case 'return':
      return insert(active, '\n')
    case 'backspace':
      return cursor === 0 ? active : { ...active, text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 }
    case 'delete':
      return { ...active, text: text.slice(0, cursor) + text.slice(cursor + 1) }
    case 'left':
      return { ...active, cursor: Math.max(0, cursor - 1) }
    case 'right':
      return { ...active, cursor: Math.min(text.length, cursor + 1) }
    case 'up':
      return { ...active, cursor: row === 0 ? 0 : cursorIn(rows, row - 1, column) }
    case 'down':
      return { ...active, cursor: row === rows.length - 1 ? text.length : cursorIn(rows, row + 1, column) }
    case 'home':
      return { ...active, cursor: rows[row]?.start ?? 0 }
    case 'end':
      return { ...active, cursor: lastIn(rows, row) }
    default:
      return SPECIAL.has(key) ? active : insert(active, key)
  }
}

// How many rows the box shows, and the first one, so that the cursor's row is in view.
export function viewOf(editor: Editor, rows: readonly Row[]) {
  const height = Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows.length))
  const row = rowAt(rows, editor.cursor)
  const top = row < editor.top ? row : row >= editor.top + height ? row - height + 1 : editor.top

  return { height, top: Math.max(0, Math.min(top, rows.length - height)) }
}

const scrolled = (editor: Editor, width: number) => ({ ...editor, top: viewOf(editor, rowsOf(editor.text, width)).top })

export const withKey = (editor: Editor, key: EditorKey, width: number) => scrolled(keyed(editor, key, width), width)

// A press puts the cursor where it landed, in the box's text cells.
export function withPress(editor: Editor, column: number, line: number, width: number): Editor {
  const rows = rowsOf(editor.text, width)
  const row = Math.min(rows.length - 1, Math.max(0, editor.top + line))

  return scrolled({ ...editor, isActive: true, cursor: cursorIn(rows, row, column) }, width)
}
