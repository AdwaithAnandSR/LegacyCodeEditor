import { NitroModules } from 'react-native-nitro-modules'
import type {
  EditorEngine,
  CursorPosition,
  TextRange,
  SearchResult,
  LineInfo,
  EditOperation,
  UndoRedoState,
  DocumentInfo,
  BracketPair,
  LineEnding,
  SyntaxToken,
} from './specs/EditorEngine.nitro'

/**
 * Create a new EditorEngine instance backed by the native C++ Piece Table
 * implementation. Each instance maintains its own document state, undo/redo
 * history, and configuration.
 *
 * @example
 * ```ts
 * const engine = createEditorEngine()
 * engine.loadContent('Hello, World!')
 * const pos = engine.insertText(1, 13, '\nNew line')
 * console.log(engine.lineCount) // 2
 * console.log(engine.getLine(1)) // 'Hello, World!'
 * console.log(engine.getLine(2)) // 'New line'
 * ```
 */
export const createEditorEngine = (): EditorEngine => {
  return NitroModules.createHybridObject<EditorEngine>('EditorEngine')
}

export type {
  EditorEngine,
  CursorPosition,
  TextRange,
  SearchResult,
  LineInfo,
  EditOperation,
  UndoRedoState,
  DocumentInfo,
  BracketPair,
  LineEnding,
  SyntaxToken,
}
