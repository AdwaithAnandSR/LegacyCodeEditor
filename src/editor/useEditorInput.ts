import { useRef, useCallback, useEffect } from "react";
import { Keyboard } from "react-native";
import type { TextInput, NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { EditorStateManager } from "./EditorStateManager";

export const SENTINEL = "\u200B";

export function useEditorInput(stateManager: EditorStateManager) {
  const inputRef = useRef<TextInput | null>(null);
  
  // We alternate between two invisible characters to detect if the OS
  // ignored our setNativeProps clear command.
  const sentinelRef = useRef<string>(SENTINEL);
  const lastTextRef = useRef<string>(SENTINEL);
  const nativeTextRef = useRef<string>(SENTINEL); // Tracks the true OS buffer
  
  const isKeyboardVisible = useRef(false);

  useEffect(() => {
    const sub1 = Keyboard.addListener("keyboardDidShow", () => {
      isKeyboardVisible.current = true;
      stateManager.isKeyboardVisible = true;
      stateManager.scrollToCursor(true);
      stateManager.invalidate();
    });
    const sub2 = Keyboard.addListener("keyboardDidHide", () => {
      isKeyboardVisible.current = false;
      stateManager.isKeyboardVisible = false;
    });
    return () => {
      sub1.remove();
      sub2.remove();
    };
  }, [stateManager]);

  const clearInput = useCallback(() => {
    // Flip the sentinel between \u200B (Zero Width Space) and \u200C (Zero Width Non-Joiner)
    sentinelRef.current = sentinelRef.current === "\u200B" ? "\u200C" : "\u200B";
    lastTextRef.current = sentinelRef.current;
    
    // Attempt to clear the native OS buffer
    // On some Android keyboards, this is asynchronously ignored if the user is typing fast
    // or if the input isn't fully controlled.
    inputRef.current?.setNativeProps({ text: sentinelRef.current });
  }, []);

  const handleTextChange = useCallback(
    (text: string) => {
      if (text === "") {
        // OS respected clear and then user backspaced the sentinel
        stateManager.backspace();
        clearInput();
        return;
      }

      let diffStr = "";
      let isBackspace = false;
      let backspaceCount = 0;

      // 1. Did the OS respect our last clearInput() command?
      if (text.startsWith(lastTextRef.current)) {
        diffStr = text.substring(lastTextRef.current.length);
      } 
      else if (lastTextRef.current.startsWith(text)) {
        isBackspace = true;
        backspaceCount = lastTextRef.current.length - text.length;
      }
      // 2. The OS IGNORED our clearInput() command and kept its old buffer!
      // (This happens if you tap to move cursor, we call clearInput, but Android ignores it)
      else if (text.startsWith(nativeTextRef.current)) {
        diffStr = text.substring(nativeTextRef.current.length);
      } 
      else if (nativeTextRef.current.startsWith(text)) {
        isBackspace = true;
        backspaceCount = nativeTextRef.current.length - text.length;
      } 
      // 3. Fallback: OS did something weird (e.g. replaced a word natively)
      else {
        // We'll just assume they appended the last typed character
        diffStr = text.substring(text.length - 1);
      }

      // Apply the diff to our engine
      if (isBackspace) {
        for (let i = 0; i < backspaceCount; i++) {
          stateManager.backspace();
        }
      } else if (diffStr.length > 0) {
        stateManager.insertAtCursor(diffStr);
      }

      // Sync refs
      lastTextRef.current = text;
      nativeTextRef.current = text;
    },
    [stateManager, clearInput],
  );

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;
      switch (key) {
        case "ArrowLeft": stateManager.moveCursorLeft(); break;
        case "ArrowRight": stateManager.moveCursorRight(); break;
        case "ArrowUp": stateManager.moveCursorUp(); break;
        case "ArrowDown": stateManager.moveCursorDown(); break;
        case "Tab": stateManager.insertAtCursor("    "); break;
      }
    },
    [stateManager],
  );

  const focus = useCallback(() => {
    const input = inputRef.current;
    if (input) {
      if (input.isFocused() && !isKeyboardVisible.current) {
        input.blur();
        setTimeout(() => input.focus(), 10);
      } else {
        input.focus();
      }
      clearInput();
    }
  }, [clearInput]);

  return { inputRef, handleTextChange, handleKeyPress, focus };
}
