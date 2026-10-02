cat << 'INNER' > patch.diff
--- src/editor/EditorCanvas.tsx
+++ src/editor/EditorCanvas.tsx
@@ -28,6 +28,7 @@
 import { useEditorScroll } from "./useEditorScroll";
 import { FloatingMenu } from "./FloatingMenu";
 import { EDITOR_THEME } from "./theme";
+import { KeyboardAccessoryBar } from "./KeyboardAccessoryBar";
 
 // ── Types ────────────────────────────────────────────────────────────────────
 
@@ -107,6 +108,8 @@
 
   // ── 9. Render ─────────────────────────────────────────────────────────
   return (
+    <View style={{ flex: 1 }}>
     <GestureDetector gesture={gesture}>
       <View style={styles.container} onLayout={handleLayout}>
         <Canvas style={StyleSheet.absoluteFill}>
@@ -134,7 +137,9 @@
         <FloatingMenu stateManager={stateManager} />
       </View>
     </GestureDetector>
+    <KeyboardAccessoryBar stateManager={stateManager} />
+    </View>
   );
 }
 
INNER
patch src/editor/EditorCanvas.tsx < patch.diff
