import re

with open('src/editor/EditorStateManager.ts', 'r') as f:
    content = f.read()

get_handle_old = """    const startX = this.getCursorXFor(this.selection.startColumn);
    const startY = this.getLineY(this.selection.startLine) + EDITOR_THEME.lineHeight; // Bottom of line
    const distStart = Math.hypot(canvasX - startX, canvasY - startY);
    
    // Check end handle
    const endX = this.getCursorXFor(this.selection.endColumn);
    const endY = this.getLineY(this.selection.endLine) + EDITOR_THEME.lineHeight;
    const distEnd = Math.hypot(canvasX - endX, canvasY - endY);
    
    const HIT_RADIUS = 30; // generous touch target"""

get_handle_new = """    const startX = this.getCursorXFor(this.selection.startColumn);
    const startY = this.getLineY(this.selection.startLine) + EDITOR_THEME.lineHeight + 10; // Center of enlarged circle
    const distStart = Math.hypot(canvasX - startX, canvasY - startY);
    
    // Check end handle
    const endX = this.getCursorXFor(this.selection.endColumn);
    const endY = this.getLineY(this.selection.endLine) + EDITOR_THEME.lineHeight + 10;
    const distEnd = Math.hypot(canvasX - endX, canvasY - endY);
    
    const HIT_RADIUS = 45; // very generous touch target"""

content = content.replace(get_handle_old, get_handle_new)

handle_drag_old = """  handleHandleDrag(canvasX: number, canvasY: number) {
    if (!this.selection || !this.activeHandle) return;
    
    const pos = this.getLineColumn(canvasX, canvasY);"""

handle_drag_new = """  handleHandleDrag(canvasX: number, canvasY: number) {
    if (!this.selection || !this.activeHandle) return;
    
    // Offset canvasY by the circle's vertical distance so dragging the handle doesn't jump down a line
    const pos = this.getLineColumn(canvasX, canvasY - EDITOR_THEME.lineHeight - 10);"""

content = content.replace(handle_drag_old, handle_drag_new)

with open('src/editor/EditorStateManager.ts', 'w') as f:
    f.write(content)
