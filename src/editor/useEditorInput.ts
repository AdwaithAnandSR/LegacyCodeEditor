import { useRef, useCallback } from "react";
import type { TextInput, NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { EditorStateManager } from "./EditorStateManager";

export const SENTINEL = "\u200B";

export function useEditorInput(stateManager: EditorStateManager) {
  const inputRef = useRef<TextInput | null>(null);
  const lastTextRef = useRef<string>(SENTINEL);

  const clearInput = useCallback(() => {
    lastTextRef.current = SENTINEL;
    inputRef.current?.setNativeProps({ text: SENTINEL });
  }, []);

  const handleTextChange = useCallback(
    (text: string) => {
      const lastText = lastTextRef.current;
      
      if (text === "") {
        // They backspaced the sentinel
        stateManager.backspace();
        clearInput();
        return;
      }

      if (text.length < lastText.length) {
        // Backspace occurred
        const diff = lastText.length - text.length;
        for (let i = 0; i < diff; i++) {
          stateManager.backspace();
        }
        lastTextRef.current = text;
      } else if (text.length > lastText.length) {
        // Text added
        const newText = text.substring(lastText.length);
        stateManager.insertAtCursor(newText);
        lastTextRef.current = text;
      } else if (text !== lastText) {
        // Edge case: same length but different string
        stateManager.backspace();
        stateManager.insertAtCursor(text.substring(text.length - 1));
        lastTextRef.current = text;
      }
    },
    [stateManager, clearInput],
  );

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;

      switch (key) {
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
          stateManager.insertAtCursor("    ");
          break;
      }
    },
    [stateManager],
  );

  const focus = useCallback(() => {
    inputRef.current?.focus();
    clearInput();
  }, [clearInput]);

  return { inputRef, handleTextChange, handleKeyPress, focus };
}
