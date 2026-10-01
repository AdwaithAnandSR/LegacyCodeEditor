with open('src/editor/SkiaRenderer.ts', 'r') as f:
    content = f.read()

content = content.replace(
    '  selectionBg: makePaint(EDITOR_THEME.selectionColor),',
    '  selectionBg: makePaint(EDITOR_THEME.selectionColor),\n  handle: makePaint(EDITOR_THEME.handleColor),'
)

with open('src/editor/SkiaRenderer.ts', 'w') as f:
    f.write(content)
