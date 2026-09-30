/**
 * useEditorScroll – gesture-based scrolling for the Skia editor canvas.
 *
 * Uses react-native-gesture-handler's Pan gesture to capture vertical
 * (and eventually horizontal) scroll, and a Tap gesture to place the
 * cursor.
 *
 * All state mutations go through EditorStateManager (imperative) —
 * no React state changes are triggered, so no re-renders occur.
 */

import { useRef, useCallback, useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import type { ComposedGestureType } from "react-native-gesture-handler/lib/typescript/handlers/gestures/gestureComposition";
import type { EditorStateManager } from "./EditorStateManager";

export interface UseEditorScrollReturn {
  /** The composed gesture to attach to `<GestureDetector>`. */
  gesture: ComposedGestureType;
}

export function useEditorScroll(
  stateManager: EditorStateManager,
  onTap?: () => void,
): UseEditorScrollReturn {
  // Track the scroll offset at the start of each pan
  const panStartY = useRef(0);
  const panStartX = useRef(0);

  const panGesture = Gesture.Pan()
    .onStart(() => {
      stateManager.stopMomentumScroll();
      panStartY.current = stateManager.scrollOffset.y;
      panStartX.current = stateManager.scrollOffset.x;
    })
    .onUpdate((e) => {
      const newY = panStartY.current - e.translationY;
      const newX = panStartX.current - e.translationX;
      stateManager.scrollOffset = {
        x: Math.max(0, newX),
        y: Math.max(0, Math.min(stateManager.maxScrollY, newY)),
      };
      stateManager.invalidate();
    })
    .onEnd((e) => {
      stateManager.startMomentumScroll(e.velocityX, e.velocityY);
    })
    .minDistance(5)
    .runOnJS(true);

  const tapGesture = Gesture.Tap()
    .onEnd((e) => {
      stateManager.handleTap(e.x, e.y);
      onTap?.();
    })
    .maxDuration(250)
    .runOnJS(true);

  const gesture = Gesture.Exclusive(panGesture, tapGesture);

  return { gesture };
}
