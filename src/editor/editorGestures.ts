import { Gesture } from "react-native-gesture-handler";
import type { ComposedGestureType } from "react-native-gesture-handler/lib/typescript/handlers/gestures/gestureComposition";
import type { EditorStateManager } from "./EditorStateManager";

export interface GestureSessionState {
  panStartY: number;
  panStartX: number;
  panStartTranslation: { x: number; y: number };
  scrollLock: 'vertical' | 'horizontal' | 'none';
  frozenX: number;
  frozenY: number;
  wasScrolling: boolean;
  gestureOwner: 'pan' | 'selection' | null;
  startedInMenu: boolean;
  startedOnHandle: boolean;
  lastTap: { time: number; x: number; y: number };
}

export function createGestureSessionState(): GestureSessionState {
  return {
    panStartY: 0,
    panStartX: 0,
    panStartTranslation: { x: 0, y: 0 },
    scrollLock: 'none',
    frozenX: 0,
    frozenY: 0,
    wasScrolling: false,
    gestureOwner: null,
    startedInMenu: false,
    startedOnHandle: false,
    lastTap: { time: 0, x: 0, y: 0 },
  };
}

export interface CreateEditorGesturesOptions {
  stateManager: EditorStateManager;
  state: GestureSessionState;
  directionalLockEnabled: boolean;
  onTap?: () => void;
}

/**
 * Pure non-hook factory that wires React Native Gesture Handler builder callbacks
 * to the imperative EditorStateManager.
 *
 * Extracted from useEditorScroll to isolate RNGH event callbacks from React hook
 * static analysis, preserving exact 60/120 FPS imperative gesture handling.
 */
export function createEditorGestures({
  stateManager,
  state,
  directionalLockEnabled,
  onTap,
}: CreateEditorGesturesOptions): ComposedGestureType {
  const panGesture = Gesture.Pan()
    .onBegin((e) => {
      state.wasScrolling = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
      }
    })
    .onStart((e) => {
      state.gestureOwner = 'pan';
      if (stateManager.activeHandle) {
        stateManager.isDraggingSelection = true;
        return;
      }
      stateManager.isFingerScrolling = true;
      state.panStartY = stateManager.scrollOffset.y;
      state.panStartX = stateManager.scrollOffset.x;
      state.panStartTranslation = { x: e.translationX, y: e.translationY };
      state.scrollLock = 'none';
      state.frozenX = 0;
      state.frozenY = 0;
    })
    .onUpdate((e) => {
      if (stateManager.activeHandle) {
        stateManager.handleHandleDrag(e.x, e.y);
        return;
      }
      const activeTranslationY = e.translationY - state.panStartTranslation.y;
      const activeTranslationX = e.translationX - state.panStartTranslation.x;

      if (directionalLockEnabled && state.scrollLock === 'none') {
        const dx = Math.abs(activeTranslationX);
        const dy = Math.abs(activeTranslationY);

        if (dx > 3 || dy > 3) {
          state.scrollLock = dx > dy ? 'horizontal' : 'vertical';
          state.frozenX = activeTranslationX;
          state.frozenY = activeTranslationY;
        }
      }

      const newY = state.scrollLock === 'horizontal'
        ? state.panStartY - state.frozenY
        : state.panStartY - activeTranslationY;

      const newX = state.scrollLock === 'vertical'
        ? state.panStartX - state.frozenX
        : state.panStartX - activeTranslationX;

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
      const velX = state.scrollLock === 'vertical' ? 0 : e.velocityX;
      const velY = state.scrollLock === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
    })
    .onFinalize(() => {
      stateManager.isFingerScrolling = false;
      if (state.gestureOwner === 'pan') {
        if (stateManager.activeHandle) {
          stateManager.activeHandle = null;
          stateManager.isDraggingSelection = false;
        }
        state.gestureOwner = null;
      }
      stateManager.invalidate();
    })
    .minDistance(5)
    .runOnJS(true);

  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(300)
    .onStart((e) => {
      state.gestureOwner = 'selection';
      state.wasScrolling = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();

      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
        stateManager.isDraggingSelection = true;
        return;
      }

      // If they are touching exactly on the active zero-width cursor, don't trigger a new word selection.
      const pos = stateManager.getLineColumn(e.x, e.y);
      if (
        stateManager.selection &&
        stateManager.selection.startLine === stateManager.selection.endLine &&
        stateManager.selection.startColumn === stateManager.selection.endColumn &&
        stateManager.selection.startLine === pos.line &&
        stateManager.selection.startColumn === pos.column
      ) {
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
      stateManager.isDraggingSelection = false;
      stateManager.activeHandle = null;
      if (state.gestureOwner === 'selection') {
        stateManager.handleSelectionEnd();
        state.gestureOwner = null;
      }
      stateManager.invalidate();
    })
    .runOnJS(true);

  const tapGesture = Gesture.Tap()
    .onBegin((e) => {
      state.startedInMenu = stateManager.isPointInFloatingMenu(e.x, e.y);
      state.startedOnHandle = !!stateManager.getHandleAt(e.x, e.y);
      state.wasScrolling = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
    })
    .onEnd((e) => {
      if (state.startedInMenu) return;
      if (!state.wasScrolling) {
        if (state.startedOnHandle) {
          stateManager.floatingMenuVisible = true;
          stateManager.invalidate();
          return;
        }

        const now = Date.now();
        const dx = Math.abs(e.x - state.lastTap.x);
        const dy = Math.abs(e.y - state.lastTap.y);

        // Detect double tap: within 300ms and finger didn't move too far
        if (now - state.lastTap.time < 300 && dx < 30 && dy < 30) {
          stateManager.handleWordSelection(e.x, e.y);
          state.lastTap.time = 0; // Reset so a 3rd tap starts over
        } else {
          stateManager.handleTap(e.x, e.y);
          state.lastTap = { time: now, x: e.x, y: e.y };
        }

        onTap?.();
      }
    })
    .runOnJS(true);

  return Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);
}
