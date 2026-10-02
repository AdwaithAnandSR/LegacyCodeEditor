cat << 'INNER' > patch.diff
--- src/editor/EditorStateManager.ts
+++ src/editor/EditorStateManager.ts
@@ -166,6 +166,49 @@
     this.invalidate();
   }
 
+  insertPair(openStr: string, closeStr: string) {
+    const normSel = this.getNormalizedSelection();
+    if (normSel) {
+      const text = this.engine.getTextInRange(normSel);
+      const newPos = this.engine.replaceText(normSel, openStr + text + closeStr);
+      this.setCursor(newPos.line, newPos.column);
+      this.selection = null;
+    } else {
+      const newPos = this.engine.insertText(this.cursorLine, this.cursorColumn, openStr + closeStr);
+      this.setCursor(newPos.line, newPos.column - closeStr.length);
+    }
+    this.resetBlink();
+    this.scrollToCursor();
+    this.invalidate();
+  }
+
+  undo() {
+    this.engine.undo();
+    this.selection = null;
+    this.setCursor(this.cursorLine, this.cursorColumn);
+    this.resetBlink();
+    this.scrollToCursor(true);
+    this.invalidate();
+  }
+
+  redo() {
+    this.engine.redo();
+    this.selection = null;
+    this.setCursor(this.cursorLine, this.cursorColumn);
+    this.resetBlink();
+    this.scrollToCursor(true);
+    this.invalidate();
+  }
+
+  indent() {
+    const normSel = this.getNormalizedSelection();
+    if (normSel) {
+      this.engine.indentLines(normSel.startLine, normSel.endLine);
+    } else {
+      this.engine.indentLine(this.cursorLine);
+      this.setCursor(this.cursorLine, this.cursorColumn + 2); // rough estimate, clamp handles overflow
+    }
+    this.resetBlink();
+    this.scrollToCursor();
+    this.invalidate();
+  }
+
+  outdent() {
+    const normSel = this.getNormalizedSelection();
+    if (normSel) {
+      this.engine.outdentLines(normSel.startLine, normSel.endLine);
+    } else {
+      this.engine.outdentLine(this.cursorLine);
+      this.setCursor(this.cursorLine, this.cursorColumn - 2);
+    }
+    this.resetBlink();
+    this.scrollToCursor();
+    this.invalidate();
+  }
+
   /**
    * Delete character before the cursor (Backspace).
    */
INNER
patch src/editor/EditorStateManager.ts < patch.diff
