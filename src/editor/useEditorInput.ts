import { useRef, useEffect, useCallback } from "react";
import { Keyboard } from "react-native";
import type { TextInput, NativeSyntheticEvent, TextInputKeyPressEventData, KeyboardEvent } from "react-native";
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

function getSentinelType(str: string): 'A' | 'B' | null {
  if (str.length === 0) return null;
  const first = str.charCodeAt(0);
  if (first === 0x200b) return 'A';
  if (first === 0x200c) return 'B';
  return null;
}

function getSentinelLength(str: string): number {
  let count = 0;
  while (count < str.length && (str.charCodeAt(count) === 0x200b || str.charCodeAt(count) === 0x200c)) {
    count++;
  }
  return count;
}

export function useEditorInput(stateManager: EditorStateManager) {
  const inputRef = useRef<TextInput | null>(null);
  
  // We alternate between two distinct long invisible strings
  const sentinelRef = useRef<string>(SENTINEL_A);
  const lastTextRef = useRef<string>(SENTINEL_A);
  const nativeTextRef = useRef<string>(SENTINEL_A); // Tracks the true OS buffer
  
  const isKeyboardVisible = useRef(false);

  useEffect(() => {
    const sub1 = Keyboard.addListener("keyboardDidShow", (e: KeyboardEvent) => {
      isKeyboardVisible.current = true;
      stateManager.isKeyboardVisible = true;
      stateManager.keyboardHeight = e.endCoordinates.height;
      stateManager.scrollToCursor(true);
      stateManager.invalidate();
    });
    const sub2 = Keyboard.addListener("keyboardDidHide", () => {
      isKeyboardVisible.current = false;
      stateManager.isKeyboardVisible = false;
      stateManager.keyboardHeight = 0;
      stateManager.invalidate();
    });
    return () => {
      sub1.remove();
      sub2.remove();
    };
  }, [stateManager]);

  // DO NOT REMOVE THIS useCallback:
  // clearInput requires a strictly stable reference identity because it is synchronized with the
  // external imperative EditorStateManager via useEffect below. Without useCallback, every render pass
  // causes the effect cleanup to execute, unbinding setClearOSBuffer(undefined) and rebinding,
  // causing lifecycle churn and breaking external buffer clearance during fast typing or menu actions.
  const clearInput = useCallback(() => {
    // Flip the sentinel between the two long invisible strings
    sentinelRef.current = sentinelRef.current === SENTINEL_A ? SENTINEL_B : SENTINEL_A;
    lastTextRef.current = sentinelRef.current;
    
    // Attempt to clear the native OS buffer
    // On some Android keyboards, this is asynchronously ignored if the user is typing fast
    // or if the input isn't fully controlled.
    inputRef.current?.setNativeProps({ text: sentinelRef.current });
  }, []);

  useEffect(() => {
    stateManager.setClearOSBuffer(clearInput);
    return () => {
      if (stateManager.clearOSBuffer === clearInput) {
        stateManager.setClearOSBuffer(undefined);
      }
    };
  }, [stateManager, clearInput]);

  const handleTextChange = (text: string) => {
      if (text === "") {
        // OS respected clear and then user backspaced the sentinel
        stateManager.backspace();
        clearInput();
        return;
      }

      let prevStr = lastTextRef.current;
      
      // If the OS ignored our clearInput() asynchronously, it will still use the old sentinel
      const textSentinel = getSentinelType(text);
      const prevSentinel = getSentinelType(prevStr);
      if (textSentinel && prevSentinel && textSentinel !== prevSentinel) {
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

      const prevSentinelLen = getSentinelLength(prevStr);

      if (commonLen === text.length) {
        // Text is a prefix of prevStr: user deleted from the end.
        const deletedCount = prevStr.length - text.length;
        if (deletedCount >= 50) {
          // Bulk deleted sentinel in OS popup (e.g. Select All + Cut/Delete)
          backspaceCount = Math.max(0, prevStr.length - prevSentinelLen);
          forceReset = true;
        } else {
          // Normal backspace into the sentinel
          backspaceCount = deletedCount;
          // Only force reset if sentinel buffer is running low (< 20 chars remaining)
          if (text.length < 20) {
            forceReset = true;
          }
        }
        diffStr = "";
      } else if (commonLen < prevSentinelLen) {
        // The sentinel itself was tampered with (e.g. user selected all and typed new text)
        backspaceCount = Math.max(0, prevStr.length - prevSentinelLen);
        diffStr = text.replace(/[\u200B\u200C]/g, "");
        forceReset = true; // We must restore the sentinel!
      } else {
        backspaceCount = prevStr.length - commonLen;
        diffStr = text.substring(commonLen).replace(/[\u200B\u200C]/g, "");
        if (text.length > 500) {
          forceReset = true;
        }
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
    };

  const handleKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;
      switch (key) {
        case "ArrowLeft": stateManager.moveCursorLeft(); break;
        case "ArrowRight": stateManager.moveCursorRight(); break;
        case "ArrowUp": stateManager.moveCursorUp(); break;
        case "ArrowDown": stateManager.moveCursorDown(); break;
        case "Tab": stateManager.insertAtCursor("    "); break;
      }
    };

  const focus = () => {
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
  };

  return { inputRef, handleTextChange, handleKeyPress, focus };
}
