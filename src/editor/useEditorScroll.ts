/* eslint-disable react-hooks/immutability, react-hooks/refs, react-hooks/purity */
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

import { useRef } from "react";
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

  const gestureOwner = useRef<'pan' | 'selection' | null>(null);

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
      gestureOwner.current = 'pan';
      if (stateManager.activeHandle) {
        stateManager.isDraggingSelection = true;
        return;
      }
      stateManager.isFingerScrolling = true;
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
        
        if (dx > 3 || dy > 3) {
          scrollLock.current = dx > dy ? 'horizontal' : 'vertical';
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
      stateManager.isFingerScrolling = false;
      const velX = scrollLock.current === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.current === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
    })
    .onFinalize(() => {
      if (gestureOwner.current === 'pan') {
        if (stateManager.activeHandle) {
          stateManager.activeHandle = null;
          stateManager.isDraggingSelection = false;
          stateManager.invalidate();
        }
        gestureOwner.current = null;
      }
    })
    .minDistance(5)
    .runOnJS(true);

  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(300)
    .onStart((e) => {
      gestureOwner.current = 'selection';
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
      
      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
        stateManager.isDraggingSelection = true;
        return;
      }
      
      // If they are touching exactly on the active zero-width cursor, don't trigger a new word selection.
      const pos = stateManager.getLineColumn(e.x, e.y);
      if (stateManager.selection && 
          stateManager.selection.startLine === stateManager.selection.endLine && 
          stateManager.selection.startColumn === stateManager.selection.endColumn &&
          stateManager.selection.startLine === pos.line &&
          stateManager.selection.startColumn === pos.column) {
        return;
      }
      
      stateManager.isDraggingSelection = true;
      stateManager.handleSelectionStart(e.x, e.y);
    })
    .onUpdate((e) => {
      if (!stateManager.isDraggingSelection) return;
      
      if (stateManager.activeHandle) {
        stateManager.handleHandleDrag(e.x, e.y);
        return;
      }
      stateManager.handleSelectionUpdate(e.x, e.y);
    })
    .onEnd(() => {
      if (stateManager.activeHandle) {
        stateManager.activeHandle = null;
        stateManager.isDraggingSelection = false;
        stateManager.invalidate();
        return;
      }
      stateManager.handleSelectionEnd();
    })
    .onFinalize(() => {
      if (gestureOwner.current === 'selection') {
        if (stateManager.activeHandle) {
          stateManager.activeHandle = null;
          stateManager.isDraggingSelection = false;
          stateManager.invalidate();
        } else {
          stateManager.handleSelectionEnd();
        }
        gestureOwner.current = null;
      }
    })
    .runOnJS(true);

  const startedInMenu = useRef(false);
  const startedOnHandle = useRef(false);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });

  const tapGesture = Gesture.Tap()
    .onBegin((e) => {
      startedInMenu.current = stateManager.isPointInFloatingMenu(e.x, e.y);
      startedOnHandle.current = !!stateManager.getHandleAt(e.x, e.y);
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
    })
    .onEnd((e) => {
      if (startedInMenu.current) return;
      if (!wasScrolling.current) {
        if (startedOnHandle.current) {
          stateManager.floatingMenuVisible = true;
          stateManager.invalidate();
          return;
        }

        const now = Date.now();
        const dx = Math.abs(e.x - lastTap.current.x);
        const dy = Math.abs(e.y - lastTap.current.y);
        
        // Detect double tap: within 300ms and finger didn't move too far
        if (now - lastTap.current.time < 300 && dx < 30 && dy < 30) {
          stateManager.handleWordSelection(e.x, e.y);
          lastTap.current.time = 0; // Reset so a 3rd tap starts over
        } else {
          stateManager.handleTap(e.x, e.y);
          lastTap.current = { time: now, x: e.x, y: e.y };
        }
        
        onTap?.();
      }
    })
    .runOnJS(true);

  const gesture = Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);

  return { gesture };
}
