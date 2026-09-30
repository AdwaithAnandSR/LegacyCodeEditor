/**
 * EditorCanvas – the main React component that composes everything.
 *
 * This component is thin glue:
 *   1. Initialises the EditorStateManager (via useRef, not state)
 *   2. Loads fonts and creates SkiaRendererResources
 *   3. Renders a <Canvas> with a <Picture> for imperative Skia drawing
 *   4. Overlays a hidden <TextInput> for keyboard input
 *   5. Wraps in <GestureDetector> for scroll & tap
 *
 * React re-renders are minimal:
 *   - Once when fonts finish loading
 *   - On each invalidate() — but the work done is just creating a new
 *     SkPicture (cheap: just recording draw commands) and updating
 *     a counter state. The actual GPU rendering is done by Skia.
 */

import { useRef, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  TextInput,
  type LayoutChangeEvent,
} from "react-native";
import {
  Canvas,
  Picture,
  useFonts,
  createPicture,
} from "@shopify/react-native-skia";
import { GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import type { SkPicture } from "@shopify/react-native-skia";

import { EditorStateManager } from "./EditorStateManager";
import {
  createEditorPicture,
  createRendererResources,
  type SkiaRendererResources,
} from "./SkiaRenderer";
import { useEditorInput, SENTINEL } from "./useEditorInput";
import { useEditorScroll } from "./useEditorScroll";
import { EDITOR_THEME } from "./theme";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditorCanvasProps {
  /** Initial content to load into the editor. */
  initialContent?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function EditorCanvas({ initialContent = "" }: EditorCanvasProps) {
  // ── 1. State manager (mutable, imperative, never triggers re-renders) ──
  const stateRef = useRef<EditorStateManager | null>(null);
  if (!stateRef.current) {
    stateRef.current = new EditorStateManager();
    stateRef.current.loadContent(initialContent);
  }
  const stateManager = stateRef.current;

  // ── 2. Load fonts ──────────────────────────────────────────────────────
  const fontProvider = useFonts({
    SpaceMono: [require("../../assets/fonts/SpaceMono-Regular.ttf")],
  });

  // ── 3. Build renderer resources once fonts are ready ───────────────────
  const resourcesRef = useRef<SkiaRendererResources | null>(null);
  if (fontProvider && !resourcesRef.current) {
    resourcesRef.current = createRendererResources(fontProvider);
  }

  // ── 4. Canvas size tracking (via ref to avoid stale closures) ────────
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      canvasSizeRef.current = { width, height };
      stateManager.setViewport(width, height);
      
      // Ensure cursor remains visible during resize animations
      stateManager.scrollToCursor(false);
      stateManager.invalidate(); // Force redraw on resize
    },
    [stateManager],
  );

  // ── 5. Redraw trigger (Bypasses React entirely!) ───────────────────────
  //
  // We use a Reanimated SharedValue to hold the SkPicture. When the state
  // manager invalidates, we imperatively create a new picture and assign it.
  // Skia listens to this SharedValue and repaints on the GPU automatically,
  // without triggering a slow React re-render.
  const pictureSV = useSharedValue<SkPicture>(
    createPicture(() => {}, { width: 1, height: 1 })
  );

  useEffect(() => {
    const cleanup = stateManager.setInvalidate(() => {
      const size = canvasSizeRef.current;
      if (resourcesRef.current && size.width > 0 && size.height > 0) {
        pictureSV.value = createEditorPicture(
          stateManager,
          resourcesRef.current,
          size.width,
          size.height,
        );
      }
    });
    stateManager.startBlink();
    return () => {
      cleanup();
      stateManager.dispose();
    };
  }, [stateManager, pictureSV]);

  // ── 6. Input hook ──────────────────────────────────────────────────────
  const { inputRef, handleTextChange, handleKeyPress, focus } =
    useEditorInput(stateManager);

  // ── 7. Scroll / tap gesture ────────────────────────────────────────────
  const charWidth = resourcesRef.current?.charWidth ?? 8;
  const { gesture } = useEditorScroll(stateManager, charWidth, focus);

  // ── 8. Loading state ──────────────────────────────────────────────────
  if (!fontProvider || !resourcesRef.current) {
    return <View style={styles.container} />;
  }

  // ── 9. Render ─────────────────────────────────────────────────────────
  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.container} onLayout={handleLayout}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Picture picture={pictureSV} />
        </Canvas>

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
            autoFocus
          />
        </View>
      </View>
    </GestureDetector>
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
