import re

with open('src/editor/EditorStateManager.ts', 'r') as f:
    content = f.read()

# Add activeHandle property
content = content.replace(
    '  selection: TextRange | null = null;',
    "  selection: TextRange | null = null;\n  activeHandle: 'start' | 'end' | null = null;"
)

# Add getCursorXFor and getHandleAt and handleHandleDrag
handle_logic = """  getCursorXFor(column: number): number {
    return (
      EDITOR_THEME.gutterWidth +
      EDITOR_THEME.contentPaddingLeft +
      column * this.charWidth -
      this.scrollOffset.x
    );
  }

  getHandleAt(canvasX: number, canvasY: number): 'start' | 'end' | null {
    if (!this.selection) return null;
    
    // Check start handle
    const startX = this.getCursorXFor(this.selection.startColumn);
    const startY = this.getLineY(this.selection.startLine) + EDITOR_THEME.lineHeight; // Bottom of line
    const distStart = Math.hypot(canvasX - startX, canvasY - startY);
    
    // Check end handle
    const endX = this.getCursorXFor(this.selection.endColumn);
    const endY = this.getLineY(this.selection.endLine) + EDITOR_THEME.lineHeight;
    const distEnd = Math.hypot(canvasX - endX, canvasY - endY);
    
    const HIT_RADIUS = 30; // generous touch target
    
    // Return whichever is closer, if within radius
    if (distStart < HIT_RADIUS && distStart <= distEnd) return 'start';
    if (distEnd < HIT_RADIUS) return 'end';
    
    return null;
  }

  handleHandleDrag(canvasX: number, canvasY: number) {
    if (!this.selection || !this.activeHandle) return;
    
    const pos = this.getLineColumn(canvasX, canvasY);
    let newSelection = { ...this.selection };
    
    if (this.activeHandle === 'start') {
        newSelection.startLine = pos.line;
        newSelection.startColumn = pos.column;
        
        // Enforce boundary: start cannot go beyond end
        if (newSelection.startLine > newSelection.endLine || 
           (newSelection.startLine === newSelection.endLine && newSelection.startColumn > newSelection.endColumn)) {
            newSelection.startLine = newSelection.endLine;
            newSelection.startColumn = newSelection.endColumn;
        }
    } else {
        newSelection.endLine = pos.line;
        newSelection.endColumn = pos.column;
        
        // Enforce boundary: end cannot go before start
        if (newSelection.endLine < newSelection.startLine || 
           (newSelection.endLine === newSelection.startLine && newSelection.endColumn < newSelection.startColumn)) {
            newSelection.endLine = newSelection.startLine;
            newSelection.endColumn = newSelection.startColumn;
        }
    }
    
    this.selection = newSelection;
    this.setCursor(this.activeHandle === 'start' ? newSelection.startLine : newSelection.endLine, 
                   this.activeHandle === 'start' ? newSelection.startColumn : newSelection.endColumn, true);
    this.scrollToCursor(false);
    this.invalidate();
  }

  getLineColumn(canvasX: number, canvasY: number): { line: number; column: number } {"""

content = content.replace("  getLineColumn(canvasX: number, canvasY: number): { line: number; column: number } {", handle_logic)

with open('src/editor/EditorStateManager.ts', 'w') as f:
    f.write(content)
