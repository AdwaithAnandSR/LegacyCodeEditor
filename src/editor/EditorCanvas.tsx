/**
 * EditorCanvas – the main React component that composes everything.
 *
 * This component is thin glue:
 *   1. Initialises the EditorStateManager (via useState lazy initializer)
 *   2. Loads fonts and creates SkiaRendererResources (via useMemo)
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

import { useRef, useEffect, useState, useMemo } from "react";
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
} from "./SkiaRenderer";
import { useEditorInput, SENTINEL } from "./useEditorInput";
import { useEditorScroll } from "./useEditorScroll";
import { FloatingMenu } from "./FloatingMenu";
import { EDITOR_THEME } from "./theme";
import { KeyboardAccessoryBar } from "./KeyboardAccessoryBar";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditorCanvasProps {
  /** Initial content to load into the editor. */
  initialContent?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function EditorCanvas({ initialContent = "" }: EditorCanvasProps) {
  const [stateManager, setStateManager] = useState<EditorStateManager | null>(null);

  useEffect(() => {
    // Defer the heavy C++ Nitro initialization (TreeSitter query compilation takes ~50-80ms).
    // Doing this synchronously in useState blocks the JS thread during the React render phase,
    // which starves the UI thread and drops the frame rate to ~13 FPS on startup.
    const idleHandle = requestIdleCallback(() => {
      const sm = new EditorStateManager();
      sm.loadContent(initialContent);
      setStateManager(sm);
    });
    return () => cancelIdleCallback(idleHandle);
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
  // DO NOT REMOVE THIS useMemo:
  // resources requires a strictly stable object identity because it is a dependency of the primary canvas
  // lifecycle effect below. Without useMemo, every re-render (layout, orientation, parent update) produces
  // a new object reference, triggering the effect teardown which executes stateManager.dispose().
  // That unnecessarily kills the cursor blink interval and Skia invalidation listeners. Additionally,
  // this prevents repeated measurement of monospace character width via Skia C++ paragraph layout.
  const resources = useMemo(
    () => (fontProvider ? createRendererResources(fontProvider) : null),
    [fontProvider]
  );

  // ── 4. Canvas size tracking (via ref to avoid stale closures) ────────
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLayout = (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      
      const widthChanged = canvasSizeRef.current.width !== width;
      const heightChanged = canvasSizeRef.current.height !== height;

      if (!widthChanged && !heightChanged) {
        return;
      }
      
      canvasSizeRef.current = { width, height };
      stateManager.setViewport(width, height);
      
      if (widthChanged) {
        // Always redraw immediately on width changes (like orientation change)
        if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
        stateManager.scrollToCursor(false);
        stateManager.invalidate();
      } else if (heightChanged) {
        // Debounce height changes to avoid FPS drops during keyboard animations
        if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
        layoutTimeoutRef.current = setTimeout(() => {
          stateManager.scrollToCursor(false);
          stateManager.invalidate();
        }, 50);
      }
    };

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
    if (resources) {
      stateManager.setCharWidth(resources.charWidth);
    }
    const cleanup = stateManager.setInvalidate(() => {
      const size = canvasSizeRef.current;
      if (resources && size.width > 0 && size.height > 0) {
        pictureSV.value = createEditorPicture(
          stateManager,
          resources,
          size.width,
          size.height,
        );
      }
    });
    stateManager.startBlink();
    return () => {
      cleanup();
      stateManager.dispose();
      if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
    };
  }, [stateManager, pictureSV, resources]);

  // ── 6. Input hook ──────────────────────────────────────────────────────
  const { inputRef, handleTextChange, handleKeyPress, focus } =
    useEditorInput(stateManager);

  // ── 7. Scroll / tap gesture ────────────────────────────────────────────
  const { gesture } = useEditorScroll(stateManager, focus);

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
