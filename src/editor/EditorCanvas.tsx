/**
 * EditorCanvas – the main React component that composes everything.
 *
 * This component is thin glue:
 *   1. Initialises the EditorStateManager (via useState lazy initializer)
 *   2. Loads fonts and creates SkiaRendererResources (via useMemo)
 *   3. Renders a <Canvas> with windowed Picture layers for 60/120fps imperative GPU drawing
 *   4. Translates content & gutter layers via Reanimated UI-thread SharedValues
 *   5. Overlays a hidden <TextInput> for keyboard input
 *   6. Wraps in <GestureDetector> for UI-thread scroll & gestures
 */

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import {
  StyleSheet,
  View,
  TextInput,
  AppState,
  type LayoutChangeEvent,
} from "react-native";
import {
  Canvas,
  Picture,
  Group,
  Rect,
  Line,
  useFonts,
  createPicture,
} from "@shopify/react-native-skia";
import { GestureDetector } from "react-native-gesture-handler";
import {
  useSharedValue,
  useDerivedValue,
  useAnimatedReaction,
  runOnJS,
} from "react-native-reanimated";
import type { SkPicture } from "@shopify/react-native-skia";

import { EditorStateManager } from "./EditorStateManager";
import {
  createEditorPictures,
  createRendererResources,
} from "./SkiaRenderer";
import { useEditorInput, SENTINEL } from "./useEditorInput";
import { useEditorScroll } from "./useEditorScroll";
import { FloatingMenu } from "./FloatingMenu";
import { CursorOverlay } from "./CursorOverlay";
import { EDITOR_THEME } from "./theme";
import { KeyboardAccessoryBar } from "./KeyboardAccessoryBar";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditorCanvasProps {
  /** Initial content to load into the editor. */
  initialContent?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

const INITIAL_PICTURE = createPicture(() => {}, { width: 1, height: 1 });

export function EditorCanvas({ initialContent = "" }: EditorCanvasProps) {
  const [stateManager, setStateManager] = useState<EditorStateManager | null>(null);

  useEffect(() => {
    // Defer the heavy C++ Nitro initialization
    const timer = setTimeout(() => {
      const sm = new EditorStateManager();
      sm.loadContent(initialContent);
      setStateManager(sm);
    }, 0);
    return () => clearTimeout(timer);
  }, [initialContent]);

  if (!stateManager) {
    return <View style={styles.container} />;
  }

  return <EditorCanvasInner stateManager={stateManager} />;
}

function EditorCanvasInner({ stateManager }: { stateManager: EditorStateManager }) {
  // ── 2. Load fonts ──────────────────────────────────────────────────────
  const fontProvider = useFonts({
    SpaceMono: [require("../../assets/fonts/SpaceMono-Regular.ttf")],
  });

  // ── 3. Build renderer resources once fonts are ready ───────────────────
  const resources = useMemo(
    () => (fontProvider ? createRendererResources(fontProvider) : null),
    [fontProvider]
  );

  // ── 4. Canvas size tracking (via ref to avoid stale closures) ────────
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const [canvasLayout, setCanvasLayout] = useState({ width: 0, height: 0 });
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;

    const widthChanged = canvasSizeRef.current.width !== width;
    const heightChanged = canvasSizeRef.current.height !== height;

    if (!widthChanged && !heightChanged) {
      return;
    }

    canvasSizeRef.current = { width, height };
    setCanvasLayout({ width, height });
    stateManager.setViewport(width, height);

    if (widthChanged) {
      if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
      stateManager.scrollToCursor(false);
      stateManager.invalidate();
    } else if (heightChanged) {
      if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = setTimeout(() => {
        stateManager.scrollToCursor(false);
        stateManager.invalidate();
      }, 50);
    }
  };

  // ── 5. UI-Thread Scroll & Windowed Picture State ────────────────────────
  const scrollX = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const maxScrollX = useSharedValue(0);
  const maxScrollY = useSharedValue(0);

  const contentPictureSV = useSharedValue<SkPicture>(INITIAL_PICTURE);
  const gutterPictureSV = useSharedValue<SkPicture>(INITIAL_PICTURE);

  const cursorDocX = useSharedValue(0);
  const cursorDocY = useSharedValue(0);
  const cursorVisible = useSharedValue(false);
  const cursorActivity = useSharedValue(0);
  const lastRecordedFirstLine = useSharedValue(1);

  const [isAppActive, setIsAppActive] = useState(true);

  // UI-thread GPU transforms
  const contentTransform = useDerivedValue(() => [
    { translateX: -scrollX.value },
    { translateY: -scrollY.value },
  ]);

  const gutterTransform = useDerivedValue(() => [
    { translateY: -scrollY.value },
  ]);

  const contentClipRect = useMemo(
    () => ({
      x: EDITOR_THEME.gutterWidth,
      y: 0,
      width: Math.max(0, canvasLayout.width - EDITOR_THEME.gutterWidth),
      height: canvasLayout.height,
    }),
    [canvasLayout.width, canvasLayout.height]
  );

  const gutterClipRect = useMemo(
    () => ({
      x: 0,
      y: 0,
      width: EDITOR_THEME.gutterWidth,
      height: canvasLayout.height,
    }),
    [canvasLayout.height]
  );

  const gutterBorderP1 = useMemo(() => ({ x: EDITOR_THEME.gutterWidth, y: 0 }), []);
  const gutterBorderP2 = useMemo(
    () => ({ x: EDITOR_THEME.gutterWidth, y: canvasLayout.height }),
    [canvasLayout.height]
  );

  useEffect(() => {
    stateManager.setScrollSharedValues(scrollX, scrollY, maxScrollX, maxScrollY);

    if (resources) {
      stateManager.setCharWidth(resources.charWidth);
    }

    const syncCursor = () => {
      const pos = stateManager.getCursorDocPosition();
      cursorDocX.value = pos.docX;
      cursorDocY.value = pos.docY;
      cursorVisible.value = pos.visible;
    };

    let isDrawScheduled = false;
    let animFrameId: number | null = null;

    const performDraw = () => {
      isDrawScheduled = false;
      const size = canvasSizeRef.current;
      if (resources && size.width > 0 && size.height > 0) {
        const windowRange = stateManager.getWindowedRange(25);
        const pictures = createEditorPictures(
          stateManager,
          resources,
          size.width,
          size.height,
          windowRange.firstLine,
          windowRange.lastLine,
        );
        contentPictureSV.value = pictures.contentPicture;
        gutterPictureSV.value = pictures.gutterPicture;
        lastRecordedFirstLine.value = Math.max(
          1,
          Math.floor(
            Math.max(0, scrollY.value - EDITOR_THEME.contentPaddingTop) /
              EDITOR_THEME.lineHeight
          ) + 1
        );
      }
      syncCursor();
    };

    const cleanup = stateManager.setInvalidate(() => {
      syncCursor();
      if (isDrawScheduled) return;
      isDrawScheduled = true;
      animFrameId = requestAnimationFrame(performDraw);
    });

    stateManager.setOnCursorActivity(() => {
      syncCursor();
      cursorActivity.value = cursorActivity.value + 1;
    });

    // Initial position sync and draw
    syncCursor();
    performDraw();

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      setIsAppActive(nextState === "active");
    });

    return () => {
      cleanup();
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
      appStateSub.remove();
      stateManager.dispose();
      if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateManager, resources]);

  // Window shift reaction: re-record pictures when scrolling crosses window buffer bounds
  const triggerWindowShift = useCallback(() => {
    const size = canvasSizeRef.current;
    if (resources && size.width > 0 && size.height > 0) {
      const windowRange = stateManager.getWindowedRange(25);
      const pictures = createEditorPictures(
        stateManager,
        resources,
        size.width,
        size.height,
        windowRange.firstLine,
        windowRange.lastLine,
      );
      // eslint-disable-next-line react-hooks/immutability
      contentPictureSV.value = pictures.contentPicture;
      // eslint-disable-next-line react-hooks/immutability
      gutterPictureSV.value = pictures.gutterPicture;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateManager, resources]);

  useAnimatedReaction(
    () => {
      const firstVis = Math.floor(
        Math.max(0, scrollY.value - EDITOR_THEME.contentPaddingTop) /
          EDITOR_THEME.lineHeight
      ) + 1;
      return Math.max(1, firstVis);
    },
    (currentFirstLine) => {
      "worklet";
      if (Math.abs(currentFirstLine - lastRecordedFirstLine.value) >= 15) {
        // eslint-disable-next-line react-hooks/immutability
        lastRecordedFirstLine.value = currentFirstLine;
        runOnJS(triggerWindowShift)();
      }
    },
    [triggerWindowShift]
  );

  // ── 6. Input hook ──────────────────────────────────────────────────────
  const { inputRef, handleTextChange, handleKeyPress, focus } =
    useEditorInput(stateManager);

  // ── 7. Scroll / tap gesture (UI-thread momentum) ────────────────────────
  const { gesture } = useEditorScroll({
    stateManager,
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    onTap: focus,
  });

  // ── 8. Loading state ──────────────────────────────────────────────────
  if (!fontProvider || !resources) {
    return <View style={styles.container} />;
  }

  // ── 9. Render ─────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>
        <View style={styles.container} onLayout={handleLayout}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Group clip={contentClipRect} transform={contentTransform}>
              <Picture picture={contentPictureSV} />
            </Group>

            <Rect
              x={0}
              y={0}
              width={EDITOR_THEME.gutterWidth}
              height={canvasLayout.height}
              color={EDITOR_THEME.gutterBackground}
            />
            <Line
              p1={gutterBorderP1}
              p2={gutterBorderP2}
              color={EDITOR_THEME.gutterBorder}
              strokeWidth={1}
            />

            <Group clip={gutterClipRect} transform={gutterTransform}>
              <Picture picture={gutterPictureSV} />
            </Group>
          </Canvas>

          <CursorOverlay
            docX={cursorDocX}
            docY={cursorDocY}
            scrollX={scrollX}
            scrollY={scrollY}
            visible={cursorVisible}
            active={isAppActive}
            activityCount={cursorActivity}
          />

          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <TextInput
              ref={inputRef}
              style={styles.ghostInput}
              defaultValue={SENTINEL}
              onChangeText={handleTextChange}
              onKeyPress={handleKeyPress}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              caretHidden={true}
              multiline={true}
              blurOnSubmit={false}
            />
          </View>

          <FloatingMenu stateManager={stateManager} />
        </View>
      </GestureDetector>
      <KeyboardAccessoryBar stateManager={stateManager} />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: EDITOR_THEME.background,
    overflow: "hidden",
  },
  ghostInput: {
    ...(StyleSheet.absoluteFill as object),
    color: "transparent",
    backgroundColor: "transparent",
    opacity: 0,
    fontSize: 1,
  },
});
