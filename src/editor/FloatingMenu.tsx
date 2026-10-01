import { useSyncExternalStore, useRef } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import * as Clipboard from 'expo-clipboard';
import type { EditorStateManager } from './EditorStateManager';
import { EDITOR_THEME } from './theme';

export function FloatingMenu({ stateManager }: { stateManager: EditorStateManager }) {
  // Sync with state manager's UI updates
  useSyncExternalStore(stateManager.subscribeUI, () => stateManager.floatingMenuSnapshot);

  const sizeRef = useRef({ width: 200, height: 40 });
  const selection = stateManager.selection;
  
  if (!selection || stateManager.isDraggingSelection || !stateManager.floatingMenuVisible) {
    stateManager.floatingMenuBounds = null;
    return null;
  }

  const handleCopy = async () => {
    const normSel = stateManager.getNormalizedSelection();
    if (!normSel) return;
    const text = stateManager.engine.getTextInRange(normSel);
    await Clipboard.setStringAsync(text);
    // Keep selection or clear it, native usually keeps it on copy. Let's keep it.
  };

  const handleCut = async () => {
    const normSel = stateManager.getNormalizedSelection();
    if (!normSel) return;
    const text = stateManager.engine.getTextInRange(normSel);
    await Clipboard.setStringAsync(text);
    
    // Engine delete
    stateManager.engine.deleteText(normSel);
    stateManager.setCursor(normSel.startLine, normSel.startColumn);
    stateManager.selection = null;
    stateManager.invalidate();
  };

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) return;
    
    const normSel = stateManager.getNormalizedSelection();
    let newPos;
    
    if (normSel) {
      newPos = stateManager.engine.replaceText(normSel, text);
    } else if (selection) {
      newPos = stateManager.engine.insertText(selection.startLine, selection.startColumn, text);
    } else {
      newPos = stateManager.engine.insertText(stateManager.cursorLine, stateManager.cursorColumn, text);
    }
    
    stateManager.setCursor(newPos.line, newPos.column);
    stateManager.selection = null;
    stateManager.floatingMenuVisible = false; // Hide menu after pasting
    stateManager.invalidate();
  };

  // Compute position above the selection
  const startLine = Math.min(selection.startLine, selection.endLine);
  
  // Base y position (absolute document coordinate)
  const lineY = stateManager.getLineY(startLine);
  
  // Convert to screen coordinate
  let y = lineY - stateManager.scrollOffset.y - 45; // 45px above the line
  
  // Simple X positioning (could be improved to center over selection)
  const x = EDITOR_THEME.gutterWidth + EDITOR_THEME.contentPaddingLeft + 20;

  // If menu goes above screen, put it below the line instead
  if (y < 10) {
    y = lineY - stateManager.scrollOffset.y + EDITOR_THEME.lineHeight + 10;
  }

  // If STILL off-screen (e.g. selection start is far above), clamp to top of viewport
  if (y < 10) {
    y = 50;
  }

  // Don't render if completely off screen vertically (at the bottom)
  if (y > stateManager.viewport.height - 20) {
    stateManager.floatingMenuBounds = null; // Ensure bounds are cleared if we don't render
    return null;
  }

  const isSelectionEmpty = selection.startLine === selection.endLine && selection.startColumn === selection.endColumn;

  // We synchronously update the bounds so the next tap can immediately be checked
  stateManager.floatingMenuBounds = {
    x, y,
    width: sizeRef.current.width,
    height: sizeRef.current.height
  };

  return (
    <View 
      style={[styles.container, { top: y, left: x }]}
      onLayout={(e) => {
        sizeRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
        stateManager.floatingMenuBounds = { x, y, width: sizeRef.current.width, height: sizeRef.current.height };
      }}
    >
      {!isSelectionEmpty && (
        <>
          <TouchableOpacity onPress={handleCut} style={styles.button}>
            <Text style={styles.text}>Cut</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity onPress={handleCopy} style={styles.button}>
            <Text style={styles.text}>Copy</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
        </>
      )}
      <TouchableOpacity onPress={handlePaste} style={styles.button}>
        <Text style={styles.text}>Paste</Text>
      </TouchableOpacity>
      <View style={styles.divider} />
      <TouchableOpacity 
        onPress={() => {
          stateManager.selectAll();
        }} 
        style={styles.button}
      >
        <Text style={styles.text}>Select All</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    flexDirection: 'row',
    backgroundColor: '#2D2D2D',
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: '#444',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 8,
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: {
    color: '#E0E0E0',
    fontSize: 14,
    fontWeight: '500',
  },
  divider: {
    width: 1,
    backgroundColor: '#444',
    marginVertical: 4,
  }
});
