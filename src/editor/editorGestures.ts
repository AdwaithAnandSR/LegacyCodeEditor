import { Gesture } from "react-native-gesture-handler";
import type { ComposedGestureType } from "react-native-gesture-handler/lib/typescript/handlers/gestures/gestureComposition";
import {
  cancelAnimation,
  withDecay,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
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
  scrollX: SharedValue<number>;
  scrollY: SharedValue<number>;
  maxScrollX: SharedValue<number>;
  maxScrollY: SharedValue<number>;
  startScrollX: SharedValue<number>;
  startScrollY: SharedValue<number>;
  scrollLock: SharedValue<'none' | 'horizontal' | 'vertical'>;
  isScrolling: SharedValue<boolean>;
  isDraggingHandle: SharedValue<boolean>;
  isDecayingX: SharedValue<boolean>;
  isDecayingY: SharedValue<boolean>;
  wasScrollingSV: SharedValue<boolean>;
  onTap?: () => void;
}

export function createEditorGestures({
  stateManager,
  state,
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
  isDecayingX,
  isDecayingY,
  wasScrollingSV,
  onTap,
}: CreateEditorGesturesOptions): ComposedGestureType {
  const checkIfOnHandle = (x: number, y: number) => {
    const handle = stateManager.getHandleAt(x, y);
    if (handle) {
      stateManager.activeHandle = handle;
      stateManager.isDraggingSelection = true;
      isDraggingHandle.value = true;
    } else {
      isDraggingHandle.value = false;
    }
  };

  const handleDragUpdate = (x: number, y: number) => {
    stateManager.handleHandleDrag(x, y);
  };

  const handleDragEnd = () => {
    stateManager.activeHandle = null;
    stateManager.isDraggingSelection = false;
    stateManager.invalidate();
  };

  const handleTapOnJS = (x: number, y: number, wasScrolling: boolean) => {
    state.startedInMenu = stateManager.isPointInFloatingMenu(x, y);
    if (state.startedInMenu) return;

    if (!wasScrolling) {
      const handle = stateManager.getHandleAt(x, y);
      if (handle) {
        stateManager.floatingMenuVisible = true;
        stateManager.invalidate();
        return;
      }

      const now = Date.now();
      const dx = Math.abs(x - state.lastTap.x);
      const dy = Math.abs(y - state.lastTap.y);

      // Detect double tap: within 300ms and finger didn't move too far
      if (now - state.lastTap.time < 300 && dx < 30 && dy < 30) {
        stateManager.handleWordSelection(x, y);
        state.lastTap.time = 0;
      } else {
        stateManager.handleTap(x, y);
        state.lastTap = { time: now, x, y };
      }

      onTap?.();
    }
  };

  // 1. UI-Thread Momentum Scrolling Pan Gesture
  const panGesture = Gesture.Pan()
    .onBegin((e) => {
      "worklet";
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);
      isDecayingX.value = false;
      isDecayingY.value = false;
      isDraggingHandle.value = false;
      runOnJS(checkIfOnHandle)(e.x, e.y);
    })
    .onStart(() => {
      "worklet";
      startScrollX.value = scrollX.value;
      startScrollY.value = scrollY.value;
      scrollLock.value = 'none';
      if (!isDraggingHandle.value) {
        isScrolling.value = true;
      }
    })
    .onUpdate((e) => {
      "worklet";
      if (isDraggingHandle.value) {
        runOnJS(handleDragUpdate)(e.x, e.y);
        return;
      }

      let activeDx = e.translationX;
      let activeDy = e.translationY;

      if (directionalLockEnabled && scrollLock.value === 'none') {
        const dx = Math.abs(activeDx);
        const dy = Math.abs(activeDy);
        if (dx > 8 && dx > dy * 1.5) {
          scrollLock.value = 'horizontal';
        } else if (dy > 8 && dy > dx * 1.5) {
          scrollLock.value = 'vertical';
        }
      }

      if (scrollLock.value === 'vertical') {
        activeDx = 0;
      } else if (scrollLock.value === 'horizontal') {
        activeDy = 0;
      }

      const targetX = startScrollX.value - activeDx;
      const targetY = startScrollY.value - activeDy;

      scrollX.value = Math.max(0, Math.min(maxScrollX.value, targetX));
      scrollY.value = Math.max(0, Math.min(maxScrollY.value, targetY));
    })
    .onEnd((e) => {
      "worklet";
      if (isDraggingHandle.value) {
        isDraggingHandle.value = false;
        isScrolling.value = false;
        runOnJS(handleDragEnd)();
        return;
      }

      const velX = scrollLock.value === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.value === 'horizontal' ? 0 : e.velocityY;

      const shouldDecayX = Math.abs(velX) > 60;
      const shouldDecayY = Math.abs(velY) > 60;

      if (!shouldDecayX && !shouldDecayY) {
        isScrolling.value = false;
        return;
      }

      if (shouldDecayX) {
        isDecayingX.value = true;
        scrollX.value = withDecay(
          {
            velocity: -velX,
            clamp: [0, maxScrollX.value],
          },
          (finished) => {
            "worklet";
            isDecayingX.value = false;
            if (!isDecayingY.value) {
              isScrolling.value = false;
            }
          }
        );
      }

      if (shouldDecayY) {
        isDecayingY.value = true;
        scrollY.value = withDecay(
          {
            velocity: -velY,
            clamp: [0, maxScrollY.value],
          },
          (finished) => {
            "worklet";
            isDecayingY.value = false;
            if (!isDecayingX.value) {
              isScrolling.value = false;
            }
          }
        );
      }
    })
    .onFinalize(() => {
      "worklet";
      if (isDraggingHandle.value) {
        isDraggingHandle.value = false;
        isScrolling.value = false;
        runOnJS(handleDragEnd)();
      }
    })
    .minDistance(5);

  // 2. Long-Press Selection Gesture
  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(300)
    .onStart((e) => {
      state.gestureOwner = 'selection';
      state.wasScrolling = isScrolling.value || isDecayingX.value || isDecayingY.value;
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);
      isDecayingX.value = false;
      isDecayingY.value = false;
      isScrolling.value = false;

      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
        stateManager.isDraggingSelection = true;
        return;
      }

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

  // 3. Instant Tap Gesture
  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      "worklet";
      const wasScrolling = isScrolling.value || isDecayingX.value || isDecayingY.value;
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);
      isDecayingX.value = false;
      isDecayingY.value = false;
      isScrolling.value = false;
      wasScrollingSV.value = wasScrolling;
    })
    .onEnd((e) => {
      "worklet";
      const wasScrolling = wasScrollingSV.value;
      wasScrollingSV.value = false;
      runOnJS(handleTapOnJS)(e.x, e.y, wasScrolling);
    });

  return Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);
}
