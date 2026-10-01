import re

with open('src/editor/EditorStateManager.ts', 'r') as f:
    content = f.read()

tap_old = """  handleTap(canvasX: number, canvasY: number) {
    this.stopMomentumScroll();
    const pos = this.getLineColumn(canvasX, canvasY);

    this.setCursor(pos.line, pos.column);"""

tap_new = """  handleTap(canvasX: number, canvasY: number) {
    this.stopMomentumScroll();
    const pos = this.getLineColumn(canvasX, canvasY);

    this.selection = null;
    this.activeHandle = null;
    this.setCursor(pos.line, pos.column);"""

content = content.replace(tap_old, tap_new)

with open('src/editor/EditorStateManager.ts', 'w') as f:
    f.write(content)
