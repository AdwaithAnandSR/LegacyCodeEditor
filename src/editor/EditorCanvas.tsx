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

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
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
} from "@shopify/react-native-skia";
import { GestureDetector } from "react-native-gesture-handler";

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

  // ── 4. Canvas size tracking ────────────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      setCanvasSize({ width, height });
      stateManager.setViewport(width, height);
    },
    [stateManager],
  );

  // ── 5. Redraw trigger ─────────────────────────────────────────────────
  //
  // A counter that increments every time the state manager says "redraw".
  // This is the ONLY React state that changes on user input.
  const [redrawKey, setRedrawKey] = useState(0);

  useEffect(() => {
    const cleanup = stateManager.setInvalidate(() => {
      setRedrawKey((k) => k + 1);
    });
    stateManager.startBlink();
    return () => {
      cleanup();
      stateManager.dispose();
    };
  }, [stateManager]);

  // ── 6. Input hook ──────────────────────────────────────────────────────
  const { inputRef, handleTextChange, handleKeyPress, focus } =
    useEditorInput(stateManager);

  // ── 7. Scroll / tap gesture ────────────────────────────────────────────
  const charWidth = resourcesRef.current?.charWidth ?? 8;
  const { gesture } = useEditorScroll(stateManager, charWidth, focus);

  // ── 8. Build the SkPicture ─────────────────────────────────────────────
  //
  // This runs on every redrawKey change. `createEditorPicture` is cheap:
  // it only *records* Skia draw commands. The actual GPU rendering happens
  // when the <Picture> component is drawn by the Canvas.
  const picture = useMemo(() => {
    if (!resourcesRef.current || canvasSize.width === 0) return null;
    return createEditorPicture(
      stateManager,
      resourcesRef.current,
      canvasSize.width,
      canvasSize.height,
    );
    // redrawKey is intentionally in deps to trigger re-creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateManager, canvasSize.width, canvasSize.height, redrawKey]);

  // ── 9. Loading state ──────────────────────────────────────────────────
  if (!fontProvider || !resourcesRef.current) {
    return <View style={styles.container} />;
  }

  // ── 10. Render ─────────────────────────────────────────────────────────
  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.container} onLayout={handleLayout}>
        <Canvas style={StyleSheet.absoluteFill}>
          {picture && <Picture picture={picture} />}
        </Canvas>

        <TextInput
          ref={inputRef}
          style={styles.ghostInput}
          pointerEvents="none"
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
