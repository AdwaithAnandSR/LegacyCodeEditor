with open('src/editor/SkiaRenderer.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "  if (state.cursorVisible) {",
    "  const hasRangeSelection = state.selection && (state.selection.startLine !== state.selection.endLine || state.selection.startColumn !== state.selection.endColumn);\n  if (state.cursorVisible && !hasRangeSelection) {"
)

with open('src/editor/SkiaRenderer.ts', 'w') as f:
    f.write(content)
