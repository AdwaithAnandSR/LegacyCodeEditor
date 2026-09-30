/**
 * useEditorInput – a hook that wires a hidden TextInput to the EditorStateManager.
 *
 * The hidden TextInput acts as the OS keyboard bridge:  it receives native
 * text events and key presses, then forwards them to the state manager.
 * The TextInput is invisible and overlaid on the canvas — the user sees
 * only the Skia-rendered text and cursor.
 *
 * This is the standard approach used by all high-performance editor shells
 * (VSCode's Monaco, CodeMirror 6, etc.) because it gets proper IME support,
 * autocorrect suppression, and keyboard events for free from the OS.
 */

import { useRef, useCallback } from "react";
import type { TextInput, NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { EditorStateManager } from "./EditorStateManager";

export interface UseEditorInputReturn {
  /** Ref to attach to the hidden TextInput. */
  inputRef: React.RefObject<TextInput | null>;
  /** onChangeText handler for the TextInput. */
  handleTextChange: (text: string) => void;
  /** onKeyPress handler for the TextInput. */
  handleKeyPress: (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  /** Focus the hidden input (call this on canvas tap). */
  focus: () => void;
}

/**
 * We keep a single-char sentinel in the TextInput so that backspace
 * events are always fired (an empty TextInput doesn't fire backspace
 * on some platforms).
 */
const SENTINEL = "\u200B"; // zero-width space

export function useEditorInput(
  stateManager: EditorStateManager,
): UseEditorInputReturn {
  const inputRef = useRef<TextInput | null>(null);

  const handleTextChange = useCallback(
    (text: string) => {
      if (text === SENTINEL || text === "") {
        // Sentinel cleared = backspace
        if (text === "") {
          stateManager.backspace();
        }
        return;
      }

      // Strip sentinel from the input and insert whatever's new
      const newText = text.replace(SENTINEL, "");
      if (newText.length > 0) {
        stateManager.insertAtCursor(newText);
      }
    },
    [stateManager],
  );

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;

      switch (key) {
        case "Backspace":
          stateManager.backspace();
          break;
        case "Enter":
          stateManager.insertNewline();
          break;
        case "ArrowLeft":
          stateManager.moveCursorLeft();
          break;
        case "ArrowRight":
          stateManager.moveCursorRight();
          break;
        case "ArrowUp":
          stateManager.moveCursorUp();
          break;
        case "ArrowDown":
          stateManager.moveCursorDown();
          break;
        case "Tab":
          stateManager.insertAtCursor("    "); // TODO: respect tabSize
          break;
        // Let default through for regular character input
      }
    },
    [stateManager],
  );

  const focus = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return { inputRef, handleTextChange, handleKeyPress, focus };
}
