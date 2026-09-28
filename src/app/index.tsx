import React, { useState, useEffect, useRef } from "react";
import { Text, View, StyleSheet, ScrollView, TouchableOpacity, SafeAreaView, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { Link } from "expo-router";
import { createEditorEngine, EditorEngine } from "editor-engine";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const assertEqual = (actual: any, expected: any, msg?: string) => {
  const isObject = (obj: any) => obj != null && typeof obj === 'object';
  const deepEqual = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (isObject(a) && isObject(b)) {
      if (Object.keys(a).length !== Object.keys(b).length) return false;
      for (const key in a) {
        if (!deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  };

  if (!deepEqual(actual, expected)) {
    throw new Error(`Expected:\n${JSON.stringify(expected)}\n\nGot:\n${JSON.stringify(actual)}\n\n${msg || ''}`);
  }
};

// ============================================================================
// ADD YOUR CUSTOM TESTS HERE
// Each test gets a completely fresh, isolated EditorEngine instance!
// ============================================================================
const TEST_CASES: Array<{ name: string; run: (engine: EditorEngine, assert: typeof assertEqual) => void }> = [
  {
    name: "Developer Custom Test Example",
    run: (engine, assert) => {
      engine.loadContent("Hello");
      engine.insertText(1, 6, " World");
      assert(engine.getContent(), "Hello World");
    }
  },
  {
    name: "Document Lifecycle: loadContent & getContent",
    run: (engine, assert) => {
      engine.loadContent("Hello\nWorld");
      assert(engine.getContent(), "Hello\nWorld");
      assert(engine.lineCount, 2);
    }
  },
  {
    name: "Document Lifecycle: markSaved and modified",
    run: (engine, assert) => {
      engine.loadContent("A");
      assert(engine.modified, false);
      engine.insertText(1, 2, "B");
      assert(engine.modified, true);
      engine.markSaved();
      assert(engine.modified, false);
    }
  },
  {
    name: "Text Manipulation: insertText",
    run: (engine, assert) => {
      engine.loadContent("Hello World");
      const pos = engine.insertText(1, 6, ","); 
      assert(engine.getContent(), "Hello, World");
      assert(pos.line, 1);
      assert(pos.column, 7);
    }
  },
  {
    name: "Text Manipulation: deleteText",
    run: (engine, assert) => {
      engine.loadContent("Hello, World");
      engine.deleteText({ startLine: 1, startColumn: 6, endLine: 1, endColumn: 7 });
      assert(engine.getContent(), "Hello World");
    }
  },
  {
    name: "Text Manipulation: replaceText",
    run: (engine, assert) => {
      engine.loadContent("Hello World");
      const pos = engine.replaceText({ startLine: 1, startColumn: 7, endLine: 1, endColumn: 12 }, "Universe");
      assert(engine.getContent(), "Hello Universe");
    }
  },
  {
    name: "Text Manipulation: applyEdits",
    run: (engine, assert) => {
      engine.loadContent("One\nTwo\nThree");
      engine.applyEdits([
        { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, text: "1" },
        { range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 }, text: "2" },
      ]);
      assert(engine.getContent(), "1\n2\nThree");
    }
  },
  {
    name: "Line Operations: getLine & getLineLength",
    run: (engine, assert) => {
      engine.loadContent("First\nSecond\nThird");
      assert(engine.getLine(2), "Second");
      assert(engine.getLineLength(2), 6);
    }
  },
  {
    name: "Range & Position: offset and position conversion",
    run: (engine, assert) => {
      engine.loadContent("A\nB");
      const offset = engine.getOffsetAt(2, 1); 
      assert(offset > 0, true);
      const pos = engine.getPositionAt(offset);
      assert(pos.line, 2);
      assert(pos.column, 1);
    }
  },
  {
    name: "Search: findAndReplace",
    run: (engine, assert) => {
      engine.loadContent("foo bar foo");
      const count = engine.findAndReplace("foo", "baz", true, false, false);
      assert(count, 2);
      assert(engine.getContent(), "baz bar baz");
    }
  },
  {
    name: "Undo / Redo Grouping",
    run: (engine, assert) => {
      engine.loadContent("A");
      engine.beginUndoGroup();
      engine.insertText(1, 2, "B");
      engine.insertText(1, 3, "C");
      engine.endUndoGroup();
      assert(engine.getContent(), "ABC");
      engine.undo();
      assert(engine.getContent(), "A");
    }
  },
  {
    name: "Indentation: indentLines & outdentLines",
    run: (engine, assert) => {
      engine.loadContent("A\nB");
      engine.tabSize = 4;
      engine.insertSpaces = true;
      engine.indentLines(1, 2);
      assert(engine.getContent(), "    A\n    B");
      engine.outdentLines(1, 2);
      assert(engine.getContent(), "A\nB");
    }
  },
  {
    name: "Utilities: clampPosition & isPositionValid",
    run: (engine, assert) => {
      engine.loadContent("Hi");
      const clamped = engine.clampPosition(5, 10);
      assert(clamped.line, 1);
      assert(engine.isPositionValid(1, 1), true);
      assert(engine.isPositionValid(5, 1), false);
    }
  }
];

export default function Index() {
  const [activeTab, setActiveTab] = useState<"suite" | "sandbox">("suite");
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);

  // Sandbox state
  const [sandboxCode, setSandboxCode] = useState(
`// The 'engine', 'assertEqual', and 'print' are available here!
engine.loadContent("Sandbox Test\\nLine 2");
engine.insertText(2, 7, " is working!");

print("Custom log: engine state looks good so far!");

assertEqual(engine.getContent(), "Sandbox Test\\nLine 2 is working!");
`
  );
  const [sandboxOutput, setSandboxOutput] = useState("");

  const runAllTests = async () => {
    setRunning(true);
    setResults([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const newResults: TestResult[] = [];

    for (const testCase of TEST_CASES) {
      // ISOLATION: Create a fresh engine for EVERY test!
      // This guarantees tests don't leak state into each other.
      const engine = createEditorEngine();
      try {
        testCase.run(engine, assertEqual);
        newResults.push({ name: testCase.name, passed: true });
      } catch (e: any) {
        newResults.push({ name: testCase.name, passed: false, error: e.message || String(e) });
      }
    }

    setResults(newResults);
    setRunning(false);
  };

  const sandboxEngineRef = useRef<EditorEngine | null>(null);

  const resetSandboxEngine = () => {
    sandboxEngineRef.current = createEditorEngine();
    setSandboxOutput("Engine reset to a fresh state.");
  };

  const runSandbox = () => {
    try {
      if (!sandboxEngineRef.current) {
        sandboxEngineRef.current = createEditorEngine();
      }
      const engine = sandboxEngineRef.current;
      
      let logs = "";
      const print = (...args: any[]) => {
        logs += args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(" ") + "\n";
      };

      setSandboxOutput("Running...");
      
      // Evaluate custom code providing engine, assertEqual, and print in scope
      const fn = new Function('engine', 'assertEqual', 'print', sandboxCode);
      fn(engine, assertEqual, print);
      
      let finalOutput = "✅ Custom Test Passed!\n\n";
      if (logs) {
        finalOutput += "--- Print Logs ---\n" + logs + "\n";
      }
      finalOutput += "Engine Content:\n" + engine.getContent() + "\n\n" + 
                     "Engine Info:\n" + JSON.stringify(engine.getDocumentInfo(), null, 2);
      
      setSandboxOutput(finalOutput);
    } catch (e: any) {
      setSandboxOutput("❌ Custom Test Failed:\n\n" + (e.message || String(e)));
    }
  };

  useEffect(() => {
    runAllTests();
  }, []);

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView 
        style={styles.container} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Editor Engine Test Runner</Text>
          <Link href="/docs" asChild>
            <TouchableOpacity style={styles.docsButton}>
              <Text style={styles.docsButtonText}>📖 View API Documentation</Text>
            </TouchableOpacity>
          </Link>
          <View style={styles.tabs}>
            <TouchableOpacity 
              style={[styles.tab, activeTab === "suite" && styles.activeTab]} 
              onPress={() => setActiveTab("suite")}
            >
              <Text style={[styles.tabText, activeTab === "suite" && styles.activeTabText]}>Test Suite</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.tab, activeTab === "sandbox" && styles.activeTab]} 
              onPress={() => setActiveTab("sandbox")}
            >
              <Text style={[styles.tabText, activeTab === "sandbox" && styles.activeTabText]}>Sandbox / REPL</Text>
            </TouchableOpacity>
          </View>
        </View>
        
        {activeTab === "suite" ? (
          <View style={{ flex: 1 }}>
            <View style={styles.summaryContainer}>
              <Text style={styles.summary}>
                {total} Tests | {passed} Passed | <Text style={failed > 0 ? styles.failedText : styles.passedText}>{failed} Failed</Text>
              </Text>
              <TouchableOpacity style={styles.button} onPress={runAllTests} disabled={running}>
                <Text style={styles.buttonText}>{running ? "Running..." : "Run Built-in Tests"}</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.list}>
              {results.map((result, i) => (
                <View key={i} style={[styles.testItem, result.passed ? styles.testPassed : styles.testFailed]}>
                  <Text style={styles.testName}>{result.passed ? "✅" : "❌"} {result.name}</Text>
                  {!result.passed && result.error && (
                    <Text style={styles.errorText}>{result.error}</Text>
                  )}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Write your own JS test case:</Text>
            <TextInput
              style={styles.codeEditor}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              value={sandboxCode}
              onChangeText={setSandboxCode}
            />
            <View style={{ flexDirection: 'row', marginTop: 10 }}>
              <TouchableOpacity style={[styles.button, { alignSelf: 'flex-start', marginRight: 10 }]} onPress={runSandbox}>
                <Text style={styles.buttonText}>▶ Run Custom Code</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { alignSelf: 'flex-start', backgroundColor: '#d32f2f' }]} onPress={resetSandboxEngine}>
                <Text style={styles.buttonText}>🔄 Reset Engine</Text>
              </TouchableOpacity>
            </View>
            
            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Output:</Text>
            <ScrollView style={styles.outputConsole}>
              <Text style={styles.outputText}>{sandboxOutput}</Text>
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f5f5" },
  container: { flex: 1, padding: 16 },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 12, color: "#333", textAlign: 'center' },
  docsButton: { backgroundColor: "#e3f2fd", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginBottom: 16, alignSelf: "center" },
  docsButtonText: { color: "#1976d2", fontWeight: "600", fontSize: 14 },
  tabs: { flexDirection: "row", backgroundColor: "#e0e0e0", borderRadius: 8, padding: 4 },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 6 },
  activeTab: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  tabText: { fontSize: 14, fontWeight: "600", color: "#666" },
  activeTabText: { color: "#007AFF" },
  summaryContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  summary: { fontSize: 15, color: "#555" },
  passedText: { color: "#2e7d32", fontWeight: "bold" },
  failedText: { color: "#c62828", fontWeight: "bold" },
  button: { backgroundColor: "#007AFF", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  buttonText: { color: "white", fontWeight: "bold", fontSize: 14 },
  list: { flex: 1 },
  testItem: { padding: 14, borderRadius: 8, marginBottom: 10, borderWidth: 1 },
  testPassed: { backgroundColor: "#e8f5e9", borderColor: "#c8e6c9" },
  testFailed: { backgroundColor: "#ffebee", borderColor: "#ffcdd2" },
  testName: { fontSize: 15, fontWeight: "600", color: "#222" },
  errorText: { marginTop: 8, color: "#c62828", fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, backgroundColor: "#ffcdd2", padding: 8, borderRadius: 4, overflow: 'hidden' },
  sectionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 8, color: "#333" },
  codeEditor: { height: 180, backgroundColor: "#1e1e1e", color: "#d4d4d4", fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, padding: 12, borderRadius: 8, textAlignVertical: 'top' },
  outputConsole: { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  outputText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: "#333" }
});
