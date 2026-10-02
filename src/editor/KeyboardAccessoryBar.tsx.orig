import React, { useState } from 'react';
import { StyleSheet, View, ScrollView, TouchableOpacity, Text } from 'react-native';
import { SwipeButton } from './SwipeButton';
import { EDITOR_THEME } from './theme';
import type { EditorStateManager } from './EditorStateManager';

interface KeyboardAccessoryBarProps {
  stateManager: EditorStateManager;
}

export function KeyboardAccessoryBar({ stateManager }: KeyboardAccessoryBarProps) {
  const [isShiftActive, setIsShiftActive] = useState(false);

  const insertText = (text: string) => {
    stateManager.insertAtCursor(text);
  };

  const insertPair = (open: string, close: string) => {
    stateManager.insertPair(open, close);
  };

  const handleTab = () => {
    if (isShiftActive) {
      stateManager.outdent();
      setIsShiftActive(false); // Reset shift after use
    } else {
      stateManager.indent();
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.scrollContent}
      >
        <SimpleButton label="Tab" onPress={handleTab} />
        <SimpleButton label="Ctrl" onPress={() => {}} />
        <SimpleButton label="Shift" onPress={() => setIsShiftActive(!isShiftActive)} isActive={isShiftActive} />
        <SimpleButton label="Undo" onPress={() => stateManager.undo()} />
        <SimpleButton label="Redo" onPress={() => stateManager.redo()} />
        
        <View style={styles.separator} />

        <SwipeButton 
          label="()" 
          onTap={() => insertPair('(', ')')}
          options={[
            { label: '(', onSelect: () => insertText('(') },
            { label: ')', onSelect: () => insertText(')') }
          ]}
        />
        
        <SwipeButton 
          label="{}" 
          onTap={() => insertPair('{', '}')}
          options={[
            { label: '{', onSelect: () => insertText('{') },
            { label: '}', onSelect: () => insertText('}') }
          ]}
        />

        <SwipeButton 
          label="[]" 
          onTap={() => insertPair('[', ']')}
          options={[
            { label: '[', onSelect: () => insertText('[') },
            { label: ']', onSelect: () => insertText(']') }
          ]}
        />

        <SwipeButton 
          label='""' 
          onTap={() => insertPair('"', '"')}
          options={[
            { label: '"', onSelect: () => insertText('"') }
          ]}
        />
        
        <SwipeButton 
          label="''" 
          onTap={() => insertPair("'", "'")}
          options={[
            { label: "'", onSelect: () => insertText("'") }
          ]}
        />
        
        <View style={styles.separator} />
        
        <SimpleButton label=";" onPress={() => insertText(";")} />
        <SimpleButton label="=" onPress={() => insertText("=")} />
        <SimpleButton label="=>" onPress={() => insertText("=>")} />
      </ScrollView>
    </View>
  );
}

function SimpleButton({ label, onPress, isActive }: { label: string, onPress: () => void, isActive?: boolean }) {
  return (
    <TouchableOpacity style={[styles.button, isActive && styles.buttonActive]} onPress={onPress}>
      <Text style={[styles.label, isActive && styles.labelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 48,
    backgroundColor: '#1E1E1E',
    borderTopWidth: 1,
    borderTopColor: '#333',
    justifyContent: 'center',
    zIndex: 10,
  },
  scrollContent: {
    paddingHorizontal: 8,
    alignItems: 'center',
    flexDirection: 'row',
  },
  button: {
    height: 40,
    minWidth: 40,
    paddingHorizontal: 12,
    marginHorizontal: 4,
    borderRadius: 6,
    backgroundColor: '#2D2D2D',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  buttonActive: {
    backgroundColor: '#007AFF',
    borderColor: '#0056b3',
  },
  label: {
    color: '#D4D4D4',
    fontSize: 15,
    fontWeight: '500',
    fontFamily: EDITOR_THEME.fontFamily,
  },
  labelActive: {
    color: '#FFFFFF',
  },
  separator: {
    width: 1,
    height: 24,
    backgroundColor: '#444',
    marginHorizontal: 8,
  }
});
