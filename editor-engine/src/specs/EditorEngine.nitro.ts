import type { HybridObject } from "react-native-nitro-modules";

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * Line ending style used in the document.
 */
export type LineEnding = "lf" | "crlf";

// ─── Structs ──────────────────────────────────────────────────────────────────

/**
 * A position in the document (1-based line, 0-based column).
 */
export interface CursorPosition {
  line: number;
  column: number;
}

/**
 * A range in the document defined by start and end positions.
 */
export interface TextRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Result of a text search operation.
 */
export interface SearchResult {
  range: TextRange;
  match: string;
}

/**
 * Information about a single line in the document.
 */
export interface LineInfo {
  lineNumber: number;
  startOffset: number;
  length: number;
  text: string;
}

/**
 * A token representing a parsed AST syntax node for highlighting.
 */
export interface SyntaxToken {
  line: number;
  startColumn: number;
  endColumn: number;
  tokenType: string;
}

/**
 * A single edit operation (replace text within a range).
 */
export interface EditOperation {
  range: TextRange;
  text: string;
}

/**
 * State of the undo/redo stack.
 */
export interface UndoRedoState {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

/**
 * Summary info about the current document.
 */
export interface DocumentInfo {
  lineCount: number;
  characterCount: number;
  lineEnding: LineEnding;
  modified: boolean;
}

/**
 * A matching bracket pair in the document.
 */
export interface BracketPair {
  openLine: number;
  openColumn: number;
  closeLine: number;
  closeColumn: number;
  bracket: string;
}

// ─── Hybrid Object ───────────────────────────────────────────────────────────

/**
 * The core text editor engine backed by a Piece Table data structure in C++.
 * Provides all text manipulation, search, undo/redo, and document introspection
 * capabilities needed by a modern code editor.
 */
export interface EditorEngine
  extends HybridObject<{ ios: "c++"; android: "c++" }> {
  // ─── Properties (readonly) ────────────────────────────────────────────────

  /** Total number of lines in the document. */
  readonly lineCount: number;
  /** Total number of characters in the document. */
  readonly characterCount: number;
  /** Whether the document has been modified since last load/save. */
  readonly modified: boolean;

  // ─── Properties (read-write) ──────────────────────────────────────────────

  /** The line ending style used for new lines. */
  lineEnding: LineEnding;
  /** Number of spaces per tab stop. */
  tabSize: number;
  /** Whether to insert spaces instead of tab characters. */
  insertSpaces: boolean;

  // ─── Document Lifecycle ───────────────────────────────────────────────────

  /** Load text content into the editor, resetting all state. */
  loadContent(content: string): void;
  /** Get the full text content of the document. */
  getContent(): string;
  /** Get a summary of the document state. */
  getDocumentInfo(): DocumentInfo;
  /** Mark the current state as the saved/unmodified baseline. */
  markSaved(): void;

  // ─── Text Manipulation ────────────────────────────────────────────────────

  /** Insert text at the given position. Returns the position after inserted text. */
  insertText(line: number, column: number, text: string): CursorPosition;
  /** Delete all text within the given range. */
  deleteText(range: TextRange): void;
  /** Replace text within the given range with new text. Returns position after replacement. */
  replaceText(range: TextRange, newText: string): CursorPosition;
  /** Apply multiple edit operations atomically (as a single undo step). */
  applyEdits(edits: EditOperation[]): void;

  // ─── Line Operations ──────────────────────────────────────────────────────

  /** Get the text content of a specific line (1-based). */
  getLine(lineNumber: number): string;
  /** Get the length of a specific line (1-based), excluding line endings. */
  getLineLength(lineNumber: number): number;
  /** Get detailed info about a specific line (1-based). */
  getLineInfo(lineNumber: number): LineInfo;
  /** Get text of multiple lines as an array (1-based, inclusive). */
  getLines(startLine: number, endLine: number): string[];
  /** Insert a new line at the given line number, pushing existing lines down. */
  insertLine(lineNumber: number, text: string): void;
  /** Delete the line at the given line number (1-based). */
  deleteLine(lineNumber: number): void;

  // ─── Range & Position ─────────────────────────────────────────────────────

  /** Get the text within a given range. */
  getTextInRange(range: TextRange): string;
  /** Convert a line/column position to a zero-based character offset. */
  getOffsetAt(line: number, column: number): number;
  /** Convert a zero-based character offset to a line/column position. */
  getPositionAt(offset: number): CursorPosition;
  /** Get the range of the word at the given position. */
  getWordRangeAtPosition(line: number, column: number): TextRange;

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Find all occurrences of a query in the document.
   * @param query - The search string (or regex pattern if isRegex is true).
   * @param caseSensitive - Whether matching should be case-sensitive.
   * @param wholeWord - Whether to match whole words only.
   * @param isRegex - Whether the query is a regular expression.
   */
  findText(
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
    isRegex: boolean
  ): SearchResult[];

  /**
   * Find and replace all occurrences. Returns the number of replacements made.
   */
  findAndReplace(
    query: string,
    replacement: string,
    caseSensitive: boolean,
    wholeWord: boolean,
    isRegex: boolean
  ): number;

  // ─── Undo / Redo ──────────────────────────────────────────────────────────

  /** Undo the last edit operation. */
  undo(): void;
  /** Redo the last undone edit operation. */
  redo(): void;
  /** Get the current undo/redo state. */
  getUndoRedoState(): UndoRedoState;
  /** Begin grouping subsequent edits into a single undo step. */
  beginUndoGroup(): void;
  /** End the current undo group. */
  endUndoGroup(): void;

  // ─── Indentation ──────────────────────────────────────────────────────────

  /** Increase indentation of a single line (1-based). */
  indentLine(lineNumber: number): void;
  /** Decrease indentation of a single line (1-based). */
  outdentLine(lineNumber: number): void;
  /** Increase indentation of a range of lines (1-based, inclusive). */
  indentLines(startLine: number, endLine: number): void;
  /** Decrease indentation of a range of lines (1-based, inclusive). */
  outdentLines(startLine: number, endLine: number): void;

  // ─── Bracket Matching ─────────────────────────────────────────────────────

  /** Find the matching bracket at the given position. Returns undefined if none found. */
  findMatchingBracket(
    line: number,
    column: number
  ): CursorPosition | undefined;

  // ─── Syntax Highlighting ──────────────────────────────────────────────────

  /** Get the parsed syntax tokens for the given line range (1-based, inclusive). */
  getSyntaxTokens(startLine: number, endLine: number): SyntaxToken[];

  // ─── Utilities ────────────────────────────────────────────────────────────

  /** Clamp a position to be within valid document bounds. */
  clampPosition(line: number, column: number): CursorPosition;
  /** Check if a given position is valid within the document. */
  isPositionValid(line: number, column: number): boolean;
  /** Get a hash of the current document content (for change detection). */
  getContentHash(): string;
}
