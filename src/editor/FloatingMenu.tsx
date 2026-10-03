import { useSyncExternalStore } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import type { EditorStateManager } from './EditorStateManager';
import { EDITOR_THEME } from './theme';

export function FloatingMenu({ stateManager }: { stateManager: EditorStateManager }) {
  // Sync with state manager's UI updates
  useSyncExternalStore(stateManager.subscribeUI, () => stateManager.floatingMenuSnapshot);

  const bounds = stateManager.getFloatingMenuBounds();
  if (!bounds) {
    return null;
  }

  const selection = stateManager.selection;
  if (!selection) {
    return null;
  }

  const handleCopy = async () => {
    const text = stateManager.copy();
    if (text) {
      await Clipboard.setStringAsync(text);
    }
  };

  const handleCut = async () => {
    const text = stateManager.cut();
    if (text) {
      await Clipboard.setStringAsync(text);
    }
  };

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      stateManager.paste(text);
    }
  };

  const isSelectionEmpty = selection.startLine === selection.endLine && selection.startColumn === selection.endColumn;

  return (
    <Animated.View 
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(100)}
      style={[styles.container, { top: bounds.y, left: bounds.x }]}
      onLayout={(e) => {
        stateManager.setFloatingMenuSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height);
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
    </Animated.View>
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
    zIndex: 999,
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: {
    color: '#E0E0E0',
    fontSize: EDITOR_THEME.fontSize,
    fontFamily: EDITOR_THEME.fontFamily,
    fontWeight: '500',
  },
  divider: {
    width: 1,
    backgroundColor: '#444',
    marginVertical: 4,
  }
});
