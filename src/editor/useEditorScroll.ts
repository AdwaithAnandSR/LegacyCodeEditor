/**
 * useEditorScroll – gesture-based scrolling for the Skia editor canvas.
 *
 * All state mutations go through EditorStateManager (imperative) —
 * no React state changes are triggered, so no re-renders occur.
 */

import { useState } from "react";
import type { ComposedGestureType } from "react-native-gesture-handler/lib/typescript/handlers/gestures/gestureComposition";
import type { EditorStateManager } from "./EditorStateManager";
import { useEditorPreferences } from "@/store/useEditorPreferences";
import { createEditorGestures, createGestureSessionState } from "./editorGestures";

export interface UseEditorScrollReturn {
  /** The composed gesture to attach to `<GestureDetector>`. */
  gesture: ComposedGestureType;
}

export function useEditorScroll(
  stateManager: EditorStateManager,
  onTap?: () => void,
): UseEditorScrollReturn {
  const [gestureState] = useState(createGestureSessionState);
  const directionalLockEnabled = useEditorPreferences(state => state.directionalLockEnabled);

  const gesture = createEditorGestures({
    stateManager,
    state: gestureState,
    directionalLockEnabled,
    onTap,
  });

  return { gesture };
}
