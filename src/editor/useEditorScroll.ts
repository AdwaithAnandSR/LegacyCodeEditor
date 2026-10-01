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
  
  const panStartTranslation = useRef({ x: 0, y: 0 });
  
  // Track which axis we are locked to for this gesture
  const scrollLock = useRef<'vertical' | 'horizontal' | 'none'>('none');
  
  // When locking an axis, we freeze the inactive axis at its current sub-pixel offset
  // rather than snapping it back to 0, completely preventing the "snap-back flick"
  const frozenX = useRef<number>(0);
  const frozenY = useRef<number>(0);

  // Track if we need to consume a tap to catch a moving scrollview
  const wasScrolling = useRef(false);

  // Pull dynamic preference from Zustand
  const directionalLockEnabled = useEditorPreferences(state => state.directionalLockEnabled);

  const panGesture = Gesture.Pan()
    .onBegin((e) => {
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
      }
    })
    .onStart((e) => {
      if (stateManager.activeHandle) {
        stateManager.isDraggingSelection = true;
        return;
      }
      panStartY.current = stateManager.scrollOffset.y;
      panStartX.current = stateManager.scrollOffset.x;
      panStartTranslation.current = { x: e.translationX, y: e.translationY };
      scrollLock.current = 'none';
      frozenX.current = 0;
      frozenY.current = 0;
    })
    .onUpdate((e) => {
      if (stateManager.activeHandle) {
        stateManager.handleHandleDrag(e.x, e.y);
        return;
      }
      const activeTranslationY = e.translationY - panStartTranslation.current.y;
      const activeTranslationX = e.translationX - panStartTranslation.current.x;

      if (directionalLockEnabled && scrollLock.current === 'none') {
        const dx = Math.abs(activeTranslationX);
        const dy = Math.abs(activeTranslationY);
        
        // Wait for just 3 pixels of active movement to reliably determine intention.
        // (Because RNGH sometimes zeroes out e.translation in onStart, we must wait for onUpdate).
        if (dx > 3 || dy > 3) {
          scrollLock.current = dx > dy ? 'horizontal' : 'vertical';
          
          // The exact millisecond we lock, freeze the inactive axis at whatever tiny 
          // 3-pixel offset it had drifted to. This prevents it from teleporting back to 0!
          frozenX.current = activeTranslationX;
          frozenY.current = activeTranslationY;
        }
      }

      const newY = scrollLock.current === 'horizontal' 
        ? panStartY.current - frozenY.current
        : panStartY.current - activeTranslationY;
        
      const newX = scrollLock.current === 'vertical' 
        ? panStartX.current - frozenX.current
        : panStartX.current - activeTranslationX;

      stateManager.scrollOffset = {
        x: Math.max(0, Math.min(stateManager.maxScrollX, newX)),
        y: Math.max(0, Math.min(stateManager.maxScrollY, newY)),
      };
      stateManager.invalidate();
    })
    .onEnd((e) => {
      if (stateManager.activeHandle) {
        stateManager.activeHandle = null;
        stateManager.isDraggingSelection = false;
        stateManager.invalidate();
        return;
      }
      const velX = scrollLock.current === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.current === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
    })
    .onFinalize(() => {
      if (stateManager.activeHandle) {
        stateManager.activeHandle = null;
        stateManager.isDraggingSelection = false;
        stateManager.invalidate();
      }
    })
    .minDistance(5)
    .runOnJS(true);

  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(300)
    .onStart((e) => {
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
      stateManager.isDraggingSelection = true;
      stateManager.handleSelectionStart(e.x, e.y);
    })
    .onUpdate((e) => {
      stateManager.handleSelectionUpdate(e.x, e.y);
    })
    .onEnd(() => {
      stateManager.isDraggingSelection = false;
      stateManager.invalidate();
    })
    .onFinalize(() => {
      stateManager.isDraggingSelection = false;
      stateManager.invalidate();
    })
    .runOnJS(true);

  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
    })
    .onEnd((e) => {
      // If the scrollview was moving, this tap just catches it. Don't move the cursor.
      if (!wasScrolling.current) {
        stateManager.handleTap(e.x, e.y);
        onTap?.();
      }
    })
    .maxDuration(250)
    .runOnJS(true);

  const gesture = Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);

  return { gesture };
}
