/**
 * useEditorScroll – gesture-based scrolling for the Skia editor canvas.
 *
 * Runs scrolling pan gestures on the UI thread with withDecay momentum,
 * completely decoupled from the JavaScript thread.
 */

import { useState } from "react";
import type { ComposedGestureType } from "react-native-gesture-handler/lib/typescript/handlers/gestures/gestureComposition";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import type { EditorStateManager } from "./EditorStateManager";
import { useEditorPreferences } from "@/store/useEditorPreferences";
import { createEditorGestures, createGestureSessionState } from "./editorGestures";

export interface UseEditorScrollOptions {
  stateManager: EditorStateManager;
  scrollX: SharedValue<number>;
  scrollY: SharedValue<number>;
  maxScrollX: SharedValue<number>;
  maxScrollY: SharedValue<number>;
  onTap?: () => void;
}

export interface UseEditorScrollReturn {
  /** The composed gesture to attach to `<GestureDetector>`. */
  gesture: ComposedGestureType;
}

export function useEditorScroll({
  stateManager,
  scrollX,
  scrollY,
  maxScrollX,
  maxScrollY,
  onTap,
}: UseEditorScrollOptions): UseEditorScrollReturn {
  const [gestureState] = useState(createGestureSessionState);
  const directionalLockEnabled = useEditorPreferences(state => state.directionalLockEnabled);

  const startScrollX = useSharedValue(0);
  const startScrollY = useSharedValue(0);
  const scrollLock = useSharedValue<'none' | 'horizontal' | 'vertical'>('none');
  const isScrolling = useSharedValue(false);
  const isDraggingHandle = useSharedValue(false);

  const gesture = createEditorGestures({
    stateManager,
    state: gestureState,
    directionalLockEnabled,
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    startScrollX,
    startScrollY,
    scrollLock,
    isScrolling,
    isDraggingHandle,
    onTap,
  });

  return { gesture };
}
