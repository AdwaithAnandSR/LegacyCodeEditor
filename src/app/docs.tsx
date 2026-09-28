import React from 'react';
import { ScrollView, Text, View, StyleSheet, SafeAreaView, Platform } from 'react-native';
import { Stack } from 'expo-router';

export default function Docs() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ title: 'API Documentation' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>EditorEngine Module Reference</Text>
        
        <Text style={styles.description}>
          The <Text style={styles.code}>editor-engine</Text> module provides a high-performance 
          text editing backend powered by a C++ Piece Table. It is designed to handle 
          large documents efficiently without modifying strings in-place.
        </Text>

        <View style={styles.section}>
          <Text style={styles.h2}>Document Lifecycle</Text>
          <Text style={styles.text}>Manage the initial state and retrieve full text.</Text>
          
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>loadContent(content: string)</Text>
            <Text style={styles.text}>Resets the editor state and loads new content.</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`engine.loadContent("function hello() {\\n}");`}</Text>
            </View>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>getContent(): string</Text>
            <Text style={styles.text}>Returns the complete document content.</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`const text = engine.getContent();`}</Text>
            </View>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>markSaved()</Text>
            <Text style={styles.text}>Flags the current document state as saved, setting <Text style={styles.code}>modified</Text> to false.</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.h2}>Text Manipulation</Text>
          
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>insertText(line, column, text): CursorPosition</Text>
            <Text style={styles.text}>Inserts string at a 1-based line and 0-based column. Returns new cursor position.</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`// Inserts '!' at line 1, column 5\nengine.insertText(1, 5, "!");`}</Text>
            </View>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>deleteText(range: TextRange)</Text>
            <Text style={styles.text}>Deletes all characters within the specified text range.</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`engine.deleteText({ startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 });`}</Text>
            </View>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>applyEdits(edits: EditOperation[])</Text>
            <Text style={styles.text}>Applies multiple replacements in one atomic undo step. Internally processes them in reverse order to preserve offsets.</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.h2}>Line Operations</Text>
          
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>getLine(lineNumber: number): string</Text>
            <Text style={styles.text}>Returns the string content of a 1-based line index, stripping the newline character.</Text>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>insertLine(lineNumber: number, text: string)</Text>
            <Text style={styles.text}>Inserts an entire new line before the target 1-based line.</Text>
          </View>

          <View style={styles.methodCard}>
            <Text style={styles.methodName}>deleteLine(lineNumber: number)</Text>
            <Text style={styles.text}>Deletes the specified line entirely.</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.h2}>Undo & Redo</Text>
          
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>undo() / redo()</Text>
            <Text style={styles.text}>Reverts or applies the most recent state change.</Text>
          </View>
          
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>beginUndoGroup() / endUndoGroup()</Text>
            <Text style={styles.text}>Groups subsequent edit commands so that a single undo() reverts all of them.</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`engine.beginUndoGroup();\nengine.insertText(1, 0, "A");\nengine.insertText(1, 1, "B");\nengine.endUndoGroup();`}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.h2}>Search</Text>
          <View style={styles.methodCard}>
            <Text style={styles.methodName}>findText(query, caseSensitive, wholeWord, isRegex): SearchResult[]</Text>
            <Text style={styles.text}>Returns an array of matching text ranges.</Text>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fcfcfc' },
  container: { flex: 1 },
  content: { padding: 20 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#111', marginBottom: 12 },
  description: { fontSize: 16, color: '#444', lineHeight: 24, marginBottom: 24 },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', backgroundColor: '#eaeaea', paddingHorizontal: 4 },
  section: { marginBottom: 24 },
  h2: { fontSize: 20, fontWeight: '700', color: '#222', marginBottom: 8, borderBottomWidth: 1, borderBottomColor: '#ddd', paddingBottom: 4 },
  text: { fontSize: 15, color: '#444', lineHeight: 22, marginBottom: 8 },
  methodCard: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#eee', elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  methodName: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 14, fontWeight: '600', color: '#d32f2f', marginBottom: 6 },
  codeBlock: { backgroundColor: '#1e1e1e', padding: 12, borderRadius: 6, marginTop: 8 },
  codeText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: '#d4d4d4' }
});
