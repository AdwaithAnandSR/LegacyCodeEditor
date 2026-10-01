with open('src/editor/SkiaRenderer.ts', 'r') as f:
    content = f.read()

draw_handles = """  // ── 7. Draw selection handles ──────────────────────────────────────────
  if (state.selection && charWidth > 0) {
    const startX = state.getCursorXFor(state.selection.startColumn);
    const startY = state.getLineY(state.selection.startLine);
    const endX = state.getCursorXFor(state.selection.endColumn);
    const endY = state.getLineY(state.selection.endLine);

    const drawHandle = (x: number, y: number) => {
        if (y + lineHeight >= state.scrollOffset.y && y <= state.scrollOffset.y + canvasHeight && x >= gutterWidth) {
            canvas.drawRect(Skia.XYWHRect(x, y, cursorWidth, lineHeight), PAINTS.handle);
            canvas.drawCircle(x + cursorWidth / 2, y + lineHeight + 6, 6, PAINTS.handle);
        }
    };
    drawHandle(startX, startY);
    drawHandle(endX, endY);
  }

  canvas.restore();"""

content = content.replace("  canvas.restore();", draw_handles)

with open('src/editor/SkiaRenderer.ts', 'w') as f:
    f.write(content)
