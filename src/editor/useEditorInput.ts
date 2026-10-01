import { useRef, useCallback, useEffect } from "react";
import { Keyboard } from "react-native";
import type { TextInput, NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { EditorStateManager } from "./EditorStateManager";

// We use 100-character invisible buffers. 
// We strictly avoid \u200D (ZWJ) and \u200E (LRM) because Android keyboards group 
// them into grapheme clusters, causing a single backspace to chunk-delete 4 chars at once!
// \u200B (Zero Width Space) and \u200C (Zero Width Non-Joiner) are completely safe.
const REPEATER_A = "\u200B\u200C";
const REPEATER_B = "\u200C\u200B";
const SENTINEL_A = REPEATER_A.repeat(50); // 100 chars
const SENTINEL_B = REPEATER_B.repeat(50); // 100 chars

export const SENTINEL = SENTINEL_A;

export function useEditorInput(stateManager: EditorStateManager) {
  const inputRef = useRef<TextInput | null>(null);
  
  // We alternate between two distinct long invisible strings
  const sentinelRef = useRef<string>(SENTINEL_A);
  const lastTextRef = useRef<string>(SENTINEL_A);
  const nativeTextRef = useRef<string>(SENTINEL_A); // Tracks the true OS buffer
  
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
    // Flip the sentinel between the two long invisible strings
    sentinelRef.current = sentinelRef.current === SENTINEL_A ? SENTINEL_B : SENTINEL_A;
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

      let prevStr = lastTextRef.current;
      
      // If the OS ignored our clearInput() asynchronously, it will still use the old sentinel
      if (text.startsWith(SENTINEL_A) && prevStr.startsWith(SENTINEL_B)) {
        prevStr = nativeTextRef.current;
      } else if (text.startsWith(SENTINEL_B) && prevStr.startsWith(SENTINEL_A)) {
        prevStr = nativeTextRef.current;
      }

      let commonLen = 0;
      const minLen = Math.min(prevStr.length, text.length);
      while (commonLen < minLen && prevStr[commonLen] === text[commonLen]) {
        commonLen++;
      }

      let diffStr = "";
      let backspaceCount = 0;
      let forceReset = false;

      if (commonLen < 100) {
        // The invisible sentinel itself was tampered with (e.g. user "Select All" in the OS popup).
        // Backspace exactly what they typed since the last clear, and insert the entirely new text.
        backspaceCount = Math.max(0, prevStr.length - 100);
        diffStr = text;
        forceReset = true; // We must restore the sentinel!
      } else {
        backspaceCount = prevStr.length - commonLen;
        diffStr = text.substring(commonLen);
      }

      // Apply the diff to our engine
      if (backspaceCount > 0) {
        stateManager.backspace(backspaceCount);
      }
      if (diffStr.length > 0) {
        stateManager.insertAtCursor(diffStr);
      }

      // Sync refs
      lastTextRef.current = text;
      nativeTextRef.current = text;

      if (forceReset) {
        clearInput();
      }
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
