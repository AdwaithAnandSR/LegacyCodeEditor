/**
 * EditorStateManager – the mutable, imperative core of the editor.
 *
 * This class is intentionally *not* React state.  It holds all the data
 * that changes on every keystroke (cursor, scroll offset, content) and is
 * read directly by the Skia canvas on every frame.  No React re-render is
 * triggered when the user types — only the native draw loop runs.
 *
 * The design separates *what* to draw from *how* to draw:
 *   - EditorStateManager answers "what" (cursor position, visible lines, etc.)
 *   - SkiaRenderer answers "how"  (paint calls, paragraphs, etc.)
 *
 * This class is also the future hook point for virtualization: once we know
 * the viewport height we can compute `firstVisibleLine` / `lastVisibleLine`
 * here and only expose that window.
 */

import { createEditorEngine, type EditorEngine, type CursorPosition, type TextRange } from "editor-engine";
import { EDITOR_THEME } from "./theme";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScrollOffset {
  x: number;
  y: number;
}

export interface ViewportInfo {
  /** Height of the visible editor area in px. */
  height: number;
  /** Width of the visible editor area in px. */
  width: number;
}

export interface VisibleRange {
  /** 1-based first visible line (inclusive). */
  firstLine: number;
  /** 1-based last visible line (inclusive). */
  lastLine: number;
}

/** Callback fired when the canvas should repaint. */
export type InvalidateCallback = () => void;

// ── Class ────────────────────────────────────────────────────────────────────

export class EditorStateManager {
  // ── Engine ───────────────────────────────────────────────────────────────
  readonly engine: EditorEngine;

  // ── Cursor ───────────────────────────────────────────────────────────────
  /** 1-based line, 0-based column. */
  cursorLine = 1;
  cursorColumn = 0;

  /** Whether the cursor blink is currently in "visible" phase. */
  cursorVisible = true;

  // ── Selection ────────────────────────────────────────────────────────────
  selection: TextRange | null = null;
  activeHandle: 'start' | 'end' | null = null;
  isDraggingSelection: boolean = false;
  isFingerScrolling: boolean = false;
  _initialWordSelection: TextRange | null = null;
  floatingMenuVisible: boolean = true;
  floatingMenuBounds: { x: number, y: number, width: number, height: number } | null = null;

  getNormalizedSelection(): TextRange | null {
    if (!this.selection || (this.selection.startLine === this.selection.endLine && this.selection.startColumn === this.selection.endColumn)) return null;
    const { startLine, startColumn, endLine, endColumn } = this.selection;
    if (startLine > endLine || (startLine === endLine && startColumn > endColumn)) {
      return { startLine: endLine, startColumn: endColumn, endLine: startLine, endColumn: startColumn };
    }
    return this.selection;
  }

  // ── Scroll ───────────────────────────────────────────────────────────────
  scrollOffset: ScrollOffset = { x: 0, y: 0 };

  // ── Viewport (set by the canvas on layout) ───────────────────────────────
  viewport: ViewportInfo = { height: 0, width: 0 };
  isKeyboardVisible: boolean = false;
  charWidth: number = 0;

  // ── Invalidation callback (set by the Skia layer) ────────────────────────
  private _invalidate: InvalidateCallback | null = null;

  // ── Cursor blink timer ───────────────────────────────────────────────────
  private _blinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.engine = createEditorEngine();
    this.engine.loadContent("");
  }

  // ── UI Subscription (for React overlays) ─────────────────────────────────
  private _uiListeners = new Set<() => void>();

  subscribeUI = (listener: () => void) => {
    this._uiListeners.add(listener);
    return () => {
      this._uiListeners.delete(listener);
    };
  };

  notifyUI() {
    this._uiListeners.forEach((cb) => cb());
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get floatingMenuSnapshot() {
    return `${this.selection?.startLine},${this.selection?.startColumn},${this.selection?.endLine},${this.selection?.endColumn},${this.isDraggingSelection},${this.isFingerScrolling},${this.isMomentumScrolling()},${this.floatingMenuVisible},${this.scrollOffset.y}`;
  }

  /**
   * Register a callback that the Skia layer calls to know when to redraw.
   * Returns a cleanup function.
   */
  setInvalidate(cb: InvalidateCallback): () => void {
    this._invalidate = cb;
    return () => {
      this._invalidate = null;
    };
  }

  /** Notify the canvas that it should repaint. */
  invalidate() {
    this._invalidate?.();
    this.notifyUI();
  }

  // ── Content ──────────────────────────────────────────────────────────────

  loadContent(text: string) {
    this.engine.loadContent(text);
    this.cursorLine = 1;
    this.cursorColumn = 0;
    this.selection = null;
    this.scrollOffset = { x: 0, y: 0 };
    this.invalidate();
  }

  // ── Text Input ───────────────────────────────────────────────────────────

  /**
   * Insert text at the current cursor position.
   * Called by the TextInput bridge when the user types.
   */
  insertAtCursor(text: string) {
    const normSel = this.getNormalizedSelection();
    if (normSel) {
      const newPos = this.engine.replaceText(normSel, text);
      this.setCursor(newPos.line, newPos.column);
      this.selection = null;
    } else {
      const newPos = this.engine.insertText(
        this.cursorLine,
        this.cursorColumn,
        text,
      );
      this.setCursor(newPos.line, newPos.column);
    }
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  /**
   * Delete the character before the cursor (backspace).
   */
  backspace() {
    const normSel = this.getNormalizedSelection();
    if (normSel) {
      this.engine.deleteText(normSel);
      this.setCursor(normSel.startLine, normSel.startColumn);
      this.selection = null;
      this.resetBlink();
      this.scrollToCursor();
      this.invalidate();
      return;
    }

    if (this.cursorColumn === 0 && this.cursorLine === 1) return;

    let deleteLine: number;
    let deleteColStart: number;

    if (this.cursorColumn > 0) {
      // Delete one character on the same line
      deleteLine = this.cursorLine;
      deleteColStart = this.cursorColumn - 1;
    } else {
      // At column 0: merge with previous line
      deleteLine = this.cursorLine - 1;
      deleteColStart = this.engine.getLineLength(deleteLine);
    }

    this.engine.deleteText({
      startLine: deleteLine,
      startColumn: deleteColStart,
      endLine: this.cursorLine,
      endColumn: this.cursorColumn,
    });

    this.setCursor(deleteLine, deleteColStart);
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  /**
   * Delete the character after the cursor (forward delete).
   */
  deleteForward() {
    const normSel = this.getNormalizedSelection();
    if (normSel) {
      this.engine.deleteText(normSel);
      this.setCursor(normSel.startLine, normSel.startColumn);
      this.selection = null;
      this.resetBlink();
      this.scrollToCursor();
      this.invalidate();
      return;
    }

    const lineCount = this.engine.lineCount;
    const lineLen = this.engine.getLineLength(this.cursorLine);

    if (this.cursorColumn >= lineLen && this.cursorLine >= lineCount) return;

    let endLine: number;
    let endCol: number;

    if (this.cursorColumn < lineLen) {
      endLine = this.cursorLine;
      endCol = this.cursorColumn + 1;
    } else {
      // At end of line: merge with next line
      endLine = this.cursorLine + 1;
      endCol = 0;
    }

    this.engine.deleteText({
      startLine: this.cursorLine,
      startColumn: this.cursorColumn,
      endLine,
      endColumn: endCol,
    });

    this.resetBlink();
    this.invalidate();
  }

  /**
   * Insert a newline at the current cursor position.
   */
  insertNewline() {
    this.insertAtCursor("\n");
  }

  // ── Cursor Movement ──────────────────────────────────────────────────────

  setCursor(line: number, column: number, keepSelection = false) {
    const clamped = this.engine.clampPosition(line, column);
    this.cursorLine = clamped.line;
    this.cursorColumn = clamped.column;
    if (!keepSelection) {
      this.selection = null;
    }
    this.resetBlink();
  }

  moveCursorLeft() {
    if (this.cursorColumn > 0) {
      this.cursorColumn--;
    } else if (this.cursorLine > 1) {
      this.cursorLine--;
      this.cursorColumn = this.engine.getLineLength(this.cursorLine);
    }
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  moveCursorRight() {
    const lineLen = this.engine.getLineLength(this.cursorLine);
    if (this.cursorColumn < lineLen) {
      this.cursorColumn++;
    } else if (this.cursorLine < this.engine.lineCount) {
      this.cursorLine++;
      this.cursorColumn = 0;
    }
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  moveCursorUp() {
    if (this.cursorLine > 1) {
      this.cursorLine--;
      const lineLen = this.engine.getLineLength(this.cursorLine);
      this.cursorColumn = Math.min(this.cursorColumn, lineLen);
    }
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  moveCursorDown() {
    if (this.cursorLine < this.engine.lineCount) {
      this.cursorLine++;
      const lineLen = this.engine.getLineLength(this.cursorLine);
      this.cursorColumn = Math.min(this.cursorColumn, lineLen);
    }
    this.resetBlink();
    this.scrollToCursor();
    this.invalidate();
  }

  // ── Scroll ───────────────────────────────────────────────────────────────

  setViewport(width: number, height: number) {
    this.viewport = { width, height };
  }

  get maxScrollY(): number {
    const scrollableHeight = this.totalContentHeight + (this.viewport.height / 2); 
    return Math.max(0, scrollableHeight - this.viewport.height);
  }

  // ── Momentum Scrolling ──
  private _momentumAnimId: number | null = null;
  private _momentumVelocity = { x: 0, y: 0 };
  private _lastMomentumTime = 0;

  isMomentumScrolling(): boolean {
    return this._momentumAnimId !== null;
  }

  startMomentumScroll(velocityX: number, velocityY: number) {
    this.stopMomentumScroll();

    
    // Velocity is from the finger. If finger moves down (positive Y), 
    // we want to scroll up (decrease scrollOffset.y). Thus, negate velocity.
    this._momentumVelocity = { x: -velocityX, y: -velocityY };
    this._lastMomentumTime = global.performance ? performance.now() : Date.now();
    
    const tick = (time: number) => {
      // requestAnimationFrame passes a timestamp, but it might be based on 
      // a different epoch than our starting time depending on the RN version.
      // We calculate our own delta safely.
      const now = global.performance ? performance.now() : Date.now();
      const dt = now - this._lastMomentumTime;
      this._lastMomentumTime = now;

      // Standard mobile deceleration rate (approx 0.998 per ms)
      const friction = 0.998; 
      const powFriction = Math.pow(friction, dt);
      
      this._momentumVelocity.x *= powFriction;
      this._momentumVelocity.y *= powFriction;

      const dx = this._momentumVelocity.x * (dt / 1000);
      const dy = this._momentumVelocity.y * (dt / 1000);

      const oldX = this.scrollOffset.x;
      const oldY = this.scrollOffset.y;

      this.scrollBy(dx, dy);

      // Stop condition: Velocity dropped below 10px/s, OR we hit a hard wall
      const hitXBound = Math.abs(dx) > 0.1 && this.scrollOffset.x === oldX;
      const hitYBound = Math.abs(dy) > 0.1 && this.scrollOffset.y === oldY;
      const velocityTooLow = Math.abs(this._momentumVelocity.x) < 10 && Math.abs(this._momentumVelocity.y) < 10;

      if (velocityTooLow || (hitXBound && hitYBound)) {
        this.stopMomentumScroll();

      } else {
        this._momentumAnimId = requestAnimationFrame(tick);
      }
    };
    
    this._momentumAnimId = requestAnimationFrame(tick);
  }

  stopMomentumScroll() {
    if (this._momentumAnimId !== null) {
      cancelAnimationFrame(this._momentumAnimId);
      this._momentumAnimId = null;
      this.invalidate(); // Re-render UI (e.g. show floating menu)
    }
  }

  animateScrollTo(targetX: number, targetY: number) {
    this.stopMomentumScroll();
    
    // Clamp targets
    const finalX = Math.max(0, targetX);
    const finalY = Math.max(0, Math.min(this.maxScrollY, targetY));
    
    if (Math.abs(this.scrollOffset.x - finalX) < 1 && Math.abs(this.scrollOffset.y - finalY) < 1) {
      this.scrollOffset = { x: finalX, y: finalY };
      return;
    }

    const durationMs = 200;
    const startX = this.scrollOffset.x;
    const startY = this.scrollOffset.y;
    const startTime = global.performance ? performance.now() : Date.now();
    
    const tick = () => {
      const now = global.performance ? performance.now() : Date.now();
      const elapsed = now - startTime;
      let progress = elapsed / durationMs;
      
      if (progress >= 1) {
        this.scrollOffset = { x: finalX, y: finalY };
        this._momentumAnimId = null;
        this.invalidate();
        return;
      }
      
      // easeOutCubic
      const ease = 1 - Math.pow(1 - progress, 3);
      this.scrollOffset = {
        x: startX + (finalX - startX) * ease,
        y: startY + (finalY - startY) * ease,
      };
      
      this.invalidate();
      this._momentumAnimId = requestAnimationFrame(tick);
    };
    
    this._momentumAnimId = requestAnimationFrame(tick);
  }

  /**
   * Update scroll offset (e.g. from a pan gesture).
   * Clamps to valid bounds.
   */
  scrollBy(dx: number, dy: number) {
    this.scrollOffset = {
      x: Math.max(0, Math.min(this.maxScrollX, this.scrollOffset.x + dx)),
      y: Math.max(0, Math.min(this.maxScrollY, this.scrollOffset.y + dy)),
    };
    this.invalidate();
  }

  scrollTo(y: number) {
    this.scrollOffset = {
      x: Math.max(0, Math.min(this.maxScrollX, this.scrollOffset.x)),
      y: Math.max(0, Math.min(this.maxScrollY, y)),
    };
    this.invalidate();
  }

  // ── Viewport / Virtualisation helpers ────────────────────────────────────

  /** Total height of all content lines in px. */
  get totalContentHeight(): number {
    return (
      this.engine.lineCount * EDITOR_THEME.lineHeight +
      EDITOR_THEME.contentPaddingTop * 2
    );
  }

  /**
   * Compute which lines are visible in the current viewport.
   * This is the hook point for future virtualisation: the renderer
   * will only iterate lines in this range.
   */
  getVisibleRange(): VisibleRange {
    const { lineHeight, contentPaddingTop } = EDITOR_THEME;
    const lineCount = this.engine.lineCount;

    const firstLine = Math.max(
      1,
      Math.floor((this.scrollOffset.y - contentPaddingTop) / lineHeight) + 1,
    );
    const visibleLines = Math.ceil(this.viewport.height / lineHeight) + 1; // +1 for partial lines
    const lastLine = Math.min(lineCount, firstLine + visibleLines);

    return { firstLine, lastLine };
  }

  /**
   * Get the absolute Y position (in document coordinates) for a 1-based line number.
   * Does NOT subtract the scroll offset.
   */
  getLineY(line: number): number {
    return (
      EDITOR_THEME.contentPaddingTop +
      (line - 1) * EDITOR_THEME.lineHeight
    );
  }

  /**
   * Compute the cursor X offset for the current column.
   * Uses character width (monospace font → all chars same width).
   */
  getCursorX(): number {
    return (
      EDITOR_THEME.gutterWidth +
      EDITOR_THEME.contentPaddingLeft +
      this.cursorColumn * this.charWidth -
      this.scrollOffset.x
    );
  }

  /**
   * Compute the cursor Y offset for the current line.
   */
  getCursorY(): number {
    return this.getLineY(this.cursorLine);
  }

  maxRenderedLineLength = 0;

  get maxScrollX(): number {
    if (this.charWidth === 0 || this.viewport.width === 0) return 0;
    const contentAreaWidth = this.viewport.width - EDITOR_THEME.gutterWidth - EDITOR_THEME.contentPaddingLeft;
    const maxContentWidth = this.maxRenderedLineLength * this.charWidth;
    // Allow scrolling up to the longest known line, plus a 100px comfort buffer
    return Math.max(0, maxContentWidth - contentAreaWidth + 100);
  }

  // ── Tap-to-place-cursor ──────────────────────────────────────────────────

  getCursorXFor(column: number): number {
    return (
      EDITOR_THEME.gutterWidth +
      EDITOR_THEME.contentPaddingLeft +
      column * this.charWidth -
      this.scrollOffset.x
    );
  }

  getHandleAt(canvasX: number, canvasY: number): 'start' | 'end' | null {
    if (!this.selection) return null;
    
    const isZeroWidth = this.selection.startLine === this.selection.endLine && this.selection.startColumn === this.selection.endColumn;
    // Check start handle
    const startX = this.getCursorXFor(this.selection.startColumn);
    const startY = this.getLineY(this.selection.startLine) - this.scrollOffset.y + EDITOR_THEME.lineHeight + 15; // Center of teardrop
    const distStart = Math.hypot(canvasX - startX, canvasY - startY);
    
    // Check end handle
    const endX = this.getCursorXFor(this.selection.endColumn);
    const endY = this.getLineY(this.selection.endLine) - this.scrollOffset.y + EDITOR_THEME.lineHeight + 15;
    const distEnd = Math.hypot(canvasX - endX, canvasY - endY);
    
    const HIT_RADIUS = 45; // very generous touch target
    
    // Return whichever is closer, if within radius
    if (distStart < HIT_RADIUS && distStart <= distEnd) return 'start';
    if (distEnd < HIT_RADIUS) return 'end';
    
    return null;
  }

  handleHandleDrag(canvasX: number, canvasY: number) {
    if (!this.selection || !this.activeHandle) return;
    
    // Offset canvasY by the circle's vertical distance so dragging the handle doesn't jump down a line
    const pos = this.getLineColumn(canvasX, canvasY - EDITOR_THEME.lineHeight - 15);
    
    const isZeroWidth = this.selection.startLine === this.selection.endLine && this.selection.startColumn === this.selection.endColumn;

    // PERF: Skip object creation if position hasn't logically changed
    if (this.activeHandle === 'start' || isZeroWidth) {
        if (this.selection.startLine === pos.line && this.selection.startColumn === pos.column) return;
    } else {
        if (this.selection.endLine === pos.line && this.selection.endColumn === pos.column) return;
    }

    let newSelection = { ...this.selection };
    
    if (isZeroWidth) {
        newSelection.startLine = pos.line;
        newSelection.startColumn = pos.column;
        newSelection.endLine = pos.line;
        newSelection.endColumn = pos.column;
    } else if (this.activeHandle === 'start') {
        newSelection.startLine = pos.line;
        newSelection.startColumn = pos.column;
    } else {
        newSelection.endLine = pos.line;
        newSelection.endColumn = pos.column;
    }
    
    this.selection = newSelection;
    this.setCursor(this.activeHandle === 'start' ? newSelection.startLine : newSelection.endLine, 
                   this.activeHandle === 'start' ? newSelection.startColumn : newSelection.endColumn, true);
    this.scrollToCursor(false, true);
    this.invalidate();
  }

  getLineColumn(canvasX: number, canvasY: number): { line: number; column: number } {
    if (this.charWidth === 0) return { line: 1, column: 0 };
    
    const { lineHeight, contentPaddingTop, gutterWidth, contentPaddingLeft } =
      EDITOR_THEME;

    // Compute line
    const absY = canvasY + this.scrollOffset.y - contentPaddingTop;
    let line = Math.floor(absY / lineHeight) + 1;
    line = Math.max(1, Math.min(this.engine.lineCount, line));

    // Compute column (only in content area, not gutter)
    const contentX = canvasX - gutterWidth - contentPaddingLeft + this.scrollOffset.x;
    let col = Math.round(contentX / this.charWidth);
    col = Math.max(0, col);

    // Clamp column to line length
    const lineLen = this.engine.getLineLength(line);
    col = Math.min(col, lineLen);

    return { line, column: col };
  }

  isPositionInSelection(line: number, column: number): boolean {
    const sel = this.getNormalizedSelection();
    if (!sel) return false;
    
    if (line < sel.startLine || line > sel.endLine) return false;
    if (line === sel.startLine && column < sel.startColumn) return false;
    if (line === sel.endLine && column > sel.endColumn) return false;
    return true;
  }

  isPointInFloatingMenu(canvasX: number, canvasY: number): boolean {
    if (!this.selection || !this.floatingMenuVisible || !this.floatingMenuBounds) return false;
    const { x, y, width, height } = this.floatingMenuBounds;
    return canvasX >= x - 10 && canvasX <= x + width + 10 && 
           canvasY >= y - 10 && canvasY <= y + height + 10;
  }

  /**
   * Given a tap in canvas coordinates, move the cursor to the
   * nearest line/column.
   */
  handleTap(canvasX: number, canvasY: number) {
    this.stopMomentumScroll();

    const handle = this.getHandleAt(canvasX, canvasY);
    if (handle) {
      this.floatingMenuVisible = true;
      this.invalidate();
      return;
    }

    const pos = this.getLineColumn(canvasX, canvasY);

    if (this.isPositionInSelection(pos.line, pos.column)) {
      const isZeroWidth = this.selection!.startLine === this.selection!.endLine && 
                          this.selection!.startColumn === this.selection!.endColumn;
      
      if (isZeroWidth) {
        // Tapping the single cursor toggles the paste menu
        this.floatingMenuVisible = !this.floatingMenuVisible;
        this.invalidate();
        return;
      }
      // If it's a range selection, we intentionally fall through to clear the selection 
      // and place the normal blinking cursor where the user tapped.
    }

    // If they tapped exactly on the blinking cursor, convert it to a 0-width selection
    // so the teardrop appears and stops blinking. Do not show menu yet.
    if (!this.selection && pos.line === this.cursorLine && pos.column === this.cursorColumn) {
      this.selection = { startLine: pos.line, startColumn: pos.column, endLine: pos.line, endColumn: pos.column };
      this.floatingMenuVisible = false; // user must tap drop again to show menu
      this.invalidate();
      return;
    }

    this.selection = null;
    this.activeHandle = null;
    this._initialWordSelection = null;
    this.floatingMenuVisible = true;
    this.setCursor(pos.line, pos.column);
    
    // Crucial: if they tapped in the empty void to the right, the column clamped.
    // We MUST snap the viewport back to the actual text so they don't get lost!
    this.scrollToCursor(false, true);
    this.invalidate();
  }

  handleWordSelection(canvasX: number, canvasY: number) {
    this.stopMomentumScroll();
    this.floatingMenuVisible = true;
    const pos = this.getLineColumn(canvasX, canvasY);
    const wordRange = this.engine.getWordRangeAtPosition(pos.line, pos.column);

    if (wordRange.startLine === wordRange.endLine && wordRange.startColumn === wordRange.endColumn) {
      this.selection = {
        startLine: pos.line,
        startColumn: pos.column,
        endLine: pos.line,
        endColumn: pos.column,
      };
      this.setCursor(pos.line, pos.column, true);
    } else {
      this.selection = { ...wordRange };
      this.setCursor(wordRange.endLine, wordRange.endColumn, true);
    }

    this.scrollToCursor(false, true);
    this.invalidate();
  }

  selectAll() {
    this.stopMomentumScroll();
    const lineCount = this.engine.lineCount;
    if (lineCount === 0) return;
    
    const lastLineLength = this.engine.getLineLength(lineCount);
    this.selection = {
      startLine: 1,
      startColumn: 0,
      endLine: lineCount,
      endColumn: lastLineLength,
    };
    this.floatingMenuVisible = true;
    this.setCursor(lineCount, lastLineLength, true);
    this.scrollToCursor(false, true);
    this.invalidate();
  }

  handleSelectionStart(canvasX: number, canvasY: number) {
    this.stopMomentumScroll();
    this.floatingMenuVisible = true;
    const pos = this.getLineColumn(canvasX, canvasY);
    const wordRange = this.engine.getWordRangeAtPosition(pos.line, pos.column);

    if (wordRange.startLine === wordRange.endLine && wordRange.startColumn === wordRange.endColumn) {
      this._initialWordSelection = null;
      this.selection = {
        startLine: pos.line,
        startColumn: pos.column,
        endLine: pos.line,
        endColumn: pos.column,
      };
    } else {
      this._initialWordSelection = { ...wordRange };
      this.selection = { ...wordRange };
    }
    this.setCursor(pos.line, pos.column, true);
    this.scrollToCursor(false, true);
    this.invalidate();
  }

  handleSelectionUpdate(canvasX: number, canvasY: number) {
    if (!this.selection) return;
    const pos = this.getLineColumn(canvasX, canvasY);
    
    let newStartLine = this.selection.startLine;
    let newStartColumn = this.selection.startColumn;

    if (this._initialWordSelection) {
      const isBefore = pos.line < this._initialWordSelection.startLine || 
                       (pos.line === this._initialWordSelection.startLine && pos.column < this._initialWordSelection.startColumn);
      
      if (isBefore) {
        newStartLine = this._initialWordSelection.endLine;
        newStartColumn = this._initialWordSelection.endColumn;
      } else {
        newStartLine = this._initialWordSelection.startLine;
        newStartColumn = this._initialWordSelection.startColumn;
      }
    }

    // PERF: Prevent unnecessary object creation & React re-renders
    if (newStartLine === this.selection.startLine && 
        newStartColumn === this.selection.startColumn &&
        this.selection.endLine === pos.line && 
        this.selection.endColumn === pos.column) {
      return;
    }

    this.selection = {
      startLine: newStartLine,
      startColumn: newStartColumn,
      endLine: pos.line,
      endColumn: pos.column,
    };
    this.setCursor(pos.line, pos.column, true);
    this.scrollToCursor(false, true);
    this.invalidate();
  }

  handleSelectionEnd() {
    this.isDraggingSelection = false;
    this._initialWordSelection = null;
    this.invalidate();
  }

  // ── Cursor blink ─────────────────────────────────────────────────────────

  startBlink() {
    this.stopBlink();
    this.cursorVisible = true;
    this._blinkTimer = setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.invalidate();
    }, EDITOR_THEME.cursorBlinkIntervalMs);
  }

  stopBlink() {
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  /** Reset blink to visible (called on every keystroke/movement). */
  private resetBlink() {
    this.cursorVisible = true;
    // Restart the timer so the cursor stays visible for a full interval
    if (this._blinkTimer) {
      this.startBlink();
    }
  }

  // ── Ensure cursor is in viewport ─────────────────────────────────────────

  scrollToCursor(forceCenter: boolean = false, preventTypewriter: boolean = false) {
    if (this.viewport.height === 0) return;

    const { lineHeight, contentPaddingTop } = EDITOR_THEME;
    const cursorY = contentPaddingTop + (this.cursorLine - 1) * lineHeight;
    
    // --- Y Scrolling Math ---
    let targetY = this.scrollOffset.y;
    const viewTop = this.scrollOffset.y;
    const viewBottom = viewTop + this.viewport.height;
    
    // Only apply typewriter centering if keyboard is visible, we are typing (not tapping/dragging),
    // and the cursor goes beyond 50% of the visible screen height.
    const isBeyond50 = cursorY + lineHeight > viewTop + this.viewport.height * 0.5;
    const shouldCenter = forceCenter || (!preventTypewriter && this.isKeyboardVisible && !this.isDraggingSelection && !this.selection && isBeyond50);
    
    if (shouldCenter) {
      targetY = cursorY - this.viewport.height * EDITOR_THEME.typewriterOffset + lineHeight / 2;
    } else {
      const viewTop = this.scrollOffset.y;
      const viewBottom = viewTop + this.viewport.height;
      const SCROLL_MARGIN_Y = 40;

      if (cursorY < viewTop + SCROLL_MARGIN_Y) {
        targetY = cursorY - SCROLL_MARGIN_Y;
      } else if (cursorY + lineHeight > viewBottom - SCROLL_MARGIN_Y) {
        targetY = cursorY + lineHeight - this.viewport.height + SCROLL_MARGIN_Y;
      }
    }

    // --- X Scrolling Math ---
    let targetX = this.scrollOffset.x;
    if (this.charWidth > 0) {
      // 10% of the screen width margin means it will auto-scroll when the cursor crosses the 90% mark
      const SCROLL_MARGIN_X = Math.max(20, this.viewport.width * 0.1);
      const textXOffset = this.cursorColumn * this.charWidth;
      const absoluteCursorX = EDITOR_THEME.gutterWidth + EDITOR_THEME.contentPaddingLeft + textXOffset;
      
      // Left boundary (prevent scrolling left text under the fixed gutter)
      if (textXOffset - this.scrollOffset.x < SCROLL_MARGIN_X) {
        targetX = textXOffset - SCROLL_MARGIN_X;
      } 
      // Right boundary (prevent text going off the right edge)
      else if (absoluteCursorX - this.scrollOffset.x > this.viewport.width - SCROLL_MARGIN_X) {
        targetX = absoluteCursorX - this.viewport.width + SCROLL_MARGIN_X;
      }
    }

    // Apply bounds smoothly if it's a large jump, otherwise snap.
    // Actually, animateScrollTo handles small jumps by returning instantly,
    // and smooths out the big typewriter jumps!
    this.animateScrollTo(targetX, targetY);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  dispose() {
    this.stopBlink();
    this._invalidate = null;
  }
}
