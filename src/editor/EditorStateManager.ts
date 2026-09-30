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

import { createEditorEngine, type EditorEngine, type CursorPosition } from "editor-engine";
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

  // ── Scroll ───────────────────────────────────────────────────────────────
  scrollOffset: ScrollOffset = { x: 0, y: 0 };

  // ── Viewport (set by the canvas on layout) ───────────────────────────────
  viewport: ViewportInfo = { height: 0, width: 0 };

  // ── Invalidation callback (set by the Skia layer) ────────────────────────
  private _invalidate: InvalidateCallback | null = null;

  // ── Cursor blink timer ───────────────────────────────────────────────────
  private _blinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.engine = createEditorEngine();
    this.engine.loadContent("");
  }

  // ── Public API ───────────────────────────────────────────────────────────

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
  }

  // ── Content ──────────────────────────────────────────────────────────────

  loadContent(text: string) {
    this.engine.loadContent(text);
    this.cursorLine = 1;
    this.cursorColumn = 0;
    this.scrollOffset = { x: 0, y: 0 };
    this.invalidate();
  }

  // ── Text Input ───────────────────────────────────────────────────────────

  /**
   * Insert text at the current cursor position.
   * Called by the TextInput bridge when the user types.
   */
  insertAtCursor(text: string) {
    const newPos = this.engine.insertText(
      this.cursorLine,
      this.cursorColumn,
      text,
    );
    this.setCursor(newPos.line, newPos.column);
    this.resetBlink();
    this.ensureCursorVisible();
    this.invalidate();
  }

  /**
   * Delete the character before the cursor (backspace).
   */
  backspace() {
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
    this.ensureCursorVisible();
    this.invalidate();
  }

  /**
   * Delete the character after the cursor (forward delete).
   */
  deleteForward() {
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

  setCursor(line: number, column: number) {
    const clamped = this.engine.clampPosition(line, column);
    this.cursorLine = clamped.line;
    this.cursorColumn = clamped.column;
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
    this.ensureCursorVisible();
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
    this.ensureCursorVisible();
    this.invalidate();
  }

  moveCursorUp() {
    if (this.cursorLine > 1) {
      this.cursorLine--;
      const lineLen = this.engine.getLineLength(this.cursorLine);
      this.cursorColumn = Math.min(this.cursorColumn, lineLen);
    }
    this.resetBlink();
    this.ensureCursorVisible();
    this.invalidate();
  }

  moveCursorDown() {
    if (this.cursorLine < this.engine.lineCount) {
      this.cursorLine++;
      const lineLen = this.engine.getLineLength(this.cursorLine);
      this.cursorColumn = Math.min(this.cursorColumn, lineLen);
    }
    this.resetBlink();
    this.ensureCursorVisible();
    this.invalidate();
  }

  // ── Scroll ───────────────────────────────────────────────────────────────

  setViewport(width: number, height: number) {
    this.viewport = { width, height };
  }

  /**
   * Update scroll offset (e.g. from a pan gesture).
   * Clamps to valid bounds.
   */
  scrollBy(dx: number, dy: number) {
    const maxY = this.totalContentHeight - this.viewport.height;
    this.scrollOffset = {
      x: Math.max(0, this.scrollOffset.x + dx),
      y: Math.max(0, Math.min(maxY, this.scrollOffset.y + dy)),
    };
    this.invalidate();
  }

  scrollTo(y: number) {
    const maxY = Math.max(0, this.totalContentHeight - this.viewport.height);
    this.scrollOffset = {
      x: this.scrollOffset.x,
      y: Math.max(0, Math.min(maxY, y)),
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
   * Get the Y position (in canvas coordinates) for a 1-based line number.
   */
  getLineY(line: number): number {
    return (
      EDITOR_THEME.contentPaddingTop +
      (line - 1) * EDITOR_THEME.lineHeight -
      this.scrollOffset.y
    );
  }

  /**
   * Compute the cursor X offset for the current column.
   * Uses character width (monospace font → all chars same width).
   */
  getCursorX(charWidth: number): number {
    return (
      EDITOR_THEME.gutterWidth +
      EDITOR_THEME.contentPaddingLeft +
      this.cursorColumn * charWidth -
      this.scrollOffset.x
    );
  }

  /**
   * Compute the cursor Y offset for the current line.
   */
  getCursorY(): number {
    return this.getLineY(this.cursorLine);
  }

  // ── Tap-to-place-cursor ──────────────────────────────────────────────────

  /**
   * Given a tap in canvas coordinates, move the cursor to the
   * nearest line/column.
   */
  handleTap(canvasX: number, canvasY: number, charWidth: number) {
    const { lineHeight, contentPaddingTop, gutterWidth, contentPaddingLeft } =
      EDITOR_THEME;

    // Compute line
    const absY = canvasY + this.scrollOffset.y - contentPaddingTop;
    let line = Math.floor(absY / lineHeight) + 1;
    line = Math.max(1, Math.min(this.engine.lineCount, line));

    // Compute column (only in content area, not gutter)
    const contentX = canvasX - gutterWidth - contentPaddingLeft + this.scrollOffset.x;
    let col = Math.round(contentX / charWidth);
    col = Math.max(0, col);

    // Clamp column to line length
    const lineLen = this.engine.getLineLength(line);
    col = Math.min(col, lineLen);

    this.setCursor(line, col);
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

  private ensureCursorVisible() {
    const { lineHeight, contentPaddingTop } = EDITOR_THEME;
    const cursorY =
      contentPaddingTop + (this.cursorLine - 1) * lineHeight;
    const viewTop = this.scrollOffset.y;
    const viewBottom = viewTop + this.viewport.height;

    if (cursorY < viewTop) {
      this.scrollOffset.y = cursorY;
    } else if (cursorY + lineHeight > viewBottom) {
      this.scrollOffset.y = cursorY + lineHeight - this.viewport.height;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  dispose() {
    this.stopBlink();
    this._invalidate = null;
  }
}
