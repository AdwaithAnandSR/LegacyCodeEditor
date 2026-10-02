cat << 'INNER' > patch1.diff
--- src/editor/KeyboardAccessoryBar.tsx
+++ src/editor/KeyboardAccessoryBar.tsx
@@ -34,6 +34,7 @@
         horizontal 
         showsHorizontalScrollIndicator={false}
         keyboardShouldPersistTaps="always"
+        style={{ overflow: 'visible' }}
         contentContainerStyle={styles.scrollContent}
       >
         <SimpleButton label="Tab" onPress={handleTab} />
@@ -107,11 +108,13 @@
     borderTopColor: '#333',
     justifyContent: 'center',
     zIndex: 10,
+    overflow: 'visible',
   },
   scrollContent: {
     paddingHorizontal: 8,
     alignItems: 'center',
     flexDirection: 'row',
+    overflow: 'visible',
   },
   button: {
     height: 40,
INNER
patch src/editor/KeyboardAccessoryBar.tsx < patch1.diff

cat << 'INNER' > patch2.diff
--- src/editor/SwipeButton.tsx
+++ src/editor/SwipeButton.tsx
@@ -100,6 +100,8 @@
     alignItems: 'center',
     justifyContent: 'center',
     marginHorizontal: 4,
+    zIndex: 100,
+    overflow: 'visible',
   },
   button: {
     height: 40,
INNER
patch src/editor/SwipeButton.tsx < patch2.diff
