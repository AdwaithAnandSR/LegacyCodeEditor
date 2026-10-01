with open('src/editor/SkiaRenderer.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "  if (state.selection && charWidth > 0) {",
    "  if (state.selection && charWidth > 0 && (state.selection.startLine !== state.selection.endLine || state.selection.startColumn !== state.selection.endColumn)) {"
)

# Wait, `if (state.selection && charWidth > 0) {` occurs twice: 
# once for background, once for handles. We want both to have this check?
# Actually, background already checks `colEnd > colStart`. So it doesn't draw anyway.
# But replacing both is fine.

with open('src/editor/SkiaRenderer.ts', 'w') as f:
    f.write(content)

with open('src/editor/EditorStateManager.ts', 'r') as f:
    content2 = f.read()

content2 = content2.replace(
    "if (!this.selection) return null;",
    "if (!this.selection || (this.selection.startLine === this.selection.endLine && this.selection.startColumn === this.selection.endColumn)) return null;"
)
with open('src/editor/EditorStateManager.ts', 'w') as f:
    f.write(content2)

