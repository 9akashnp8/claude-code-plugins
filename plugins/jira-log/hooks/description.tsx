import type { ClientModule } from 'claude-code'

import { editorOf, rowAt, rowsOf, viewOf, withKey, withPress, type Editor } from './editor'

export type DescriptionProps = { text: string; placeholder: string }

// The round border and one column of padding each side, and a column for the cursor past a line's end.
const FRAME_COLUMNS = 5

// The ticket's description as a text area: it starts from the text drawn with it, grows with what is typed
// up to MAX_ROWS rows and then scrolls, and posts each change to the hooks module.
const Description: ClientModule<DescriptionProps, Editor> = (props, surface) => {
  const { Box, Text } = surface.elements
  // The region is 0 wide until it is first laid out.
  const widthNow = () => Math.max(10, (surface.columns || 64) - FRAME_COLUMNS)
  const width = widthNow()
  const editor = surface.state ?? editorOf(props.text)
  if (surface.state === undefined) {
    const apply = (next: Editor) => {
      const before = surface.state ?? editor
      surface.setState(next)
      if (next.text !== before.text) surface.post({ description: next.text })
    }
    surface.onKey(key => apply(withKey(surface.state ?? editor, key, widthNow())))
    surface.onPointer(event => {
      if (event.type === 'down') apply(withPress(surface.state ?? editor, event.x - 2, event.y - 1, widthNow()))
    })
    surface.setState(editor)
  }
  const rows = rowsOf(editor.text, width)
  const { height, top } = viewOf(editor, rows)
  const cursorRow = rowAt(rows, editor.cursor)
  const lines = Array.from({ length: height }, (_, index) => {
    const row = rows[top + index]
    const text = row === undefined ? '' : editor.text.slice(row.start, row.end)
    if (row === undefined || !editor.isActive || top + index !== cursorRow) {
      return <Text key={`row-${index}`}>{text || ' '}</Text>
    }
    const at = editor.cursor - row.start

    // One run of text with the cursor cell nested in it, so the spaces beside the cursor stay where they are.
    return (
      <Text key={`row-${index}`}>
        {text.slice(0, at)}
        <Text inverse>{text.charAt(at) || ' '}</Text>
        {text.slice(at + 1)}
      </Text>
    )
  })
  const isBlank = editor.text === '' && !editor.isActive

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderDimColor paddingX={1}>
      {isBlank ? (
        <Box flexDirection="column">
          <Text dimColor>{props.placeholder}</Text>
          {lines.slice(1)}
        </Box>
      ) : (
        lines
      )}
    </Box>
  )
}

export default Description
