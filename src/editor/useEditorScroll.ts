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
  charWidth: number,
  onTap?: () => void,
): UseEditorScrollReturn {
  // Track the scroll offset at the start of each pan
  const panStartY = useRef(0);
  const panStartX = useRef(0);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          panStartY.current = stateManager.scrollOffset.y;
          panStartX.current = stateManager.scrollOffset.x;
        })
        .onUpdate((e) => {
          const newY = panStartY.current - e.translationY;
          const newX = panStartX.current - e.translationX;
          const maxY = Math.max(
            0,
            stateManager.totalContentHeight - stateManager.viewport.height,
          );
          stateManager.scrollOffset = {
            x: Math.max(0, newX),
            y: Math.max(0, Math.min(maxY, newY)),
          };
          stateManager.invalidate();
        })
        .minDistance(5)
        .runOnJS(true),
    [stateManager],
  );

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .onEnd((e) => {
          stateManager.handleTap(e.x, e.y, charWidth);
          onTap?.();
        })
        .maxDuration(250)
        .runOnJS(true),
    [stateManager, charWidth, onTap],
  );

  const gesture = useMemo(
    () => Gesture.Race(panGesture, tapGesture),
    [panGesture, tapGesture],
  );

  return { gesture };
}
