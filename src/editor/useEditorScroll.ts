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
import { useEditorPreferences } from "@/store/useEditorPreferences";

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
  
  // Track which axis we are locked to for this gesture
  const scrollLock = useRef<'vertical' | 'horizontal' | 'none'>('none');

  // Pull dynamic preference from Zustand
  const { directionalLockEnabled } = useEditorPreferences();

  const panGesture = Gesture.Pan()
    .onStart(() => {
      stateManager.stopMomentumScroll();
      panStartY.current = stateManager.scrollOffset.y;
      panStartX.current = stateManager.scrollOffset.x;
      scrollLock.current = 'none';
    })
    .onUpdate((e) => {
      if (directionalLockEnabled) {
        // Fingers are imprecise. The first 5 pixels of a horizontal swipe 
        // are often slightly diagonal, causing false-positive vertical locks.
        // We wait until the gesture has moved 20 pixels in any direction 
        // to establish a clean, undeniable trajectory before permanently locking.
        if (scrollLock.current === 'none') {
          if (Math.abs(e.translationX) > 20 || Math.abs(e.translationY) > 20) {
            scrollLock.current = Math.abs(e.translationX) > Math.abs(e.translationY)
              ? 'horizontal'
              : 'vertical';
          }
        }
      } else {
        // If disabled, never lock axes
        scrollLock.current = 'none';
      }

      // While 'none', we freely apply both (natural micro-movements)
      const newY = scrollLock.current === 'horizontal' 
        ? panStartY.current 
        : panStartY.current - e.translationY;
        
      const newX = scrollLock.current === 'vertical' 
        ? panStartX.current 
        : panStartX.current - e.translationX;

      stateManager.scrollOffset = {
        x: Math.max(0, newX),
        y: Math.max(0, Math.min(stateManager.maxScrollY, newY)),
      };
      stateManager.invalidate();
    })
    .onEnd((e) => {
      // Only pass momentum to the unlocked axis
      const velX = scrollLock.current === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.current === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
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
