import React, { useState, useEffect, useRef, useCallback } from "react";
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

// ─── Notebook Cell Types ─────────────────────────────────────────────────────

type CellType = 'code' | 'markdown';
type CellStatus = 'idle' | 'running' | 'success' | 'error';

interface NotebookCell {
  id: string;
  type: CellType;
  code: string;
  output: string;
  status: CellStatus;
  executionCount: number | null;
  collapsed: boolean;
}

let cellIdCounter = 0;
const createCell = (code = '', type: CellType = 'code'): NotebookCell => ({
  id: `cell-${++cellIdCounter}`,
  type,
  code,
  output: '',
  status: 'idle',
  executionCount: null,
  collapsed: false,
});

// ─── Notebook Cell Component ─────────────────────────────────────────────────

interface CellProps {
  cell: NotebookCell;
  index: number;
  totalCells: number;
  isRunningAll: boolean;
  onCodeChange: (id: string, code: string) => void;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onAddBelow: (id: string) => void;
  onToggleType: (id: string) => void;
}

const CellComponent = React.memo(({
  cell,
  index,
  totalCells,
  isRunningAll,
  onCodeChange,
  onRun,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleCollapse,
  onAddBelow,
  onToggleType,
}: CellProps) => {
  const statusColor =
    cell.status === 'success' ? '#4caf50' :
    cell.status === 'error' ? '#f44336' :
    cell.status === 'running' ? '#ff9800' :
    '#bdbdbd';

  const executionLabel = cell.executionCount != null
    ? `[${cell.executionCount}]`
    : '[ ]';

  // Calculate dynamic height based on line count
  const lineCount = Math.max((cell.code.split('\n').length), 1);
  const editorHeight = Math.max(44, Math.min(lineCount * 20 + 24, 300));

  return (
    <View style={nb.cellWrapper}>
      {/* Cell */}
      <View style={[nb.cell, { borderLeftColor: statusColor }]}>
        {/* Cell header */}
        <View style={nb.cellHeader}>
          <View style={nb.cellHeaderLeft}>
            {/* Run button */}
            <TouchableOpacity
              style={nb.runBtn}
              onPress={() => onRun(cell.id)}
              disabled={isRunningAll}
            >
              <Text style={nb.runBtnText}>
                {cell.status === 'running' ? '⏳' : '▶'}
              </Text>
            </TouchableOpacity>

            <Text style={[nb.execCount, { color: statusColor }]}>
              {executionLabel}
            </Text>

            <TouchableOpacity
              style={nb.typeToggle}
              onPress={() => onToggleType(cell.id)}
            >
              <Text style={nb.typeToggleText}>
                {cell.type === 'code' ? '{ }' : 'Md'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={nb.cellHeaderRight}>
            <TouchableOpacity
              onPress={() => onToggleCollapse(cell.id)}
              style={nb.headerIconBtn}
            >
              <Text style={nb.headerIconText}>{cell.collapsed ? '▼' : '▲'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onMoveUp(cell.id)}
              disabled={index === 0}
              style={[nb.headerIconBtn, index === 0 && nb.disabledBtn]}
            >
              <Text style={nb.headerIconText}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onMoveDown(cell.id)}
              disabled={index === totalCells - 1}
              style={[nb.headerIconBtn, index === totalCells - 1 && nb.disabledBtn]}
            >
              <Text style={nb.headerIconText}>↓</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onDelete(cell.id)}
              disabled={totalCells <= 1}
              style={[nb.headerIconBtn, totalCells <= 1 && nb.disabledBtn]}
            >
              <Text style={[nb.headerIconText, { color: totalCells > 1 ? '#f44336' : '#ccc' }]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Code editor (collapsible) */}
        {!cell.collapsed && (
          <TextInput
            style={[
              cell.type === 'code' ? nb.codeInput : nb.markdownInput,
              { height: editorHeight },
            ]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            value={cell.code}
            onChangeText={(text) => onCodeChange(cell.id, text)}
            placeholder={cell.type === 'code' ? '// Write code here...' : '# Markdown notes...'}
            placeholderTextColor="#666"
          />
        )}

        {/* Output */}
        {cell.output !== '' && !cell.collapsed && (
          <View style={[
            nb.outputContainer,
            cell.status === 'error' ? nb.outputError : nb.outputSuccess,
          ]}>
            <Text style={nb.outputText}>{cell.output}</Text>
          </View>
        )}
      </View>

      {/* Add cell button between cells */}
      <TouchableOpacity
        style={nb.addCellBtn}
        onPress={() => onAddBelow(cell.id)}
      >
        <Text style={nb.addCellBtnText}>+ Cell</Text>
      </TouchableOpacity>
    </View>
  );
});

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Index() {
  const [activeTab, setActiveTab] = useState<"suite" | "notebook">("suite");
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);

  // Notebook state
  const [cells, setCells] = useState<NotebookCell[]>(() => [
    createCell('// Cell 1: Load content into the engine\nengine.loadContent("Hello World\\nLine 2\\nLine 3");\n\nprint("Lines:", engine.lineCount);\nprint("Content:", engine.getContent());'),
    createCell('// Cell 2: Manipulate text (engine state carries over!)\nengine.insertText(1, 12, " — Edited");\n\nprint("After insert:", engine.getContent());'),
    createCell('// Cell 3: Inspect engine state\nprint("Document Info:", engine.getDocumentInfo());\nprint("Line 1:", engine.getLine(1));\nprint("Modified:", engine.modified);'),
  ]);
  const [executionCounter, setExecutionCounter] = useState(0);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const engineRef = useRef<EditorEngine | null>(null);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = createEditorEngine();
    }
    return engineRef.current;
  }, []);

  // ── Test Suite ──────────────────────────────────────────────────────────

  const runAllTests = async () => {
    setRunning(true);
    setResults([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const newResults: TestResult[] = [];

    for (const testCase of TEST_CASES) {
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

  // ── Notebook Cell Execution ─────────────────────────────────────────────

  const runCell = useCallback((cellId: string) => {
    const engine = getEngine();

    setCells(prev => {
      const idx = prev.findIndex(c => c.id === cellId);
      if (idx === -1) return prev;
      const cell = prev[idx];

      // Skip markdown cells
      if (cell.type === 'markdown') {
        const updated = [...prev];
        updated[idx] = { ...cell, status: 'success', output: '(Markdown cell — rendered above)', executionCount: null };
        return updated;
      }

      // Mark as running
      const updated = [...prev];
      updated[idx] = { ...cell, status: 'running', output: '' };
      return updated;
    });

    // Run async to allow UI update
    setTimeout(() => {
      setCells(prev => {
        const idx = prev.findIndex(c => c.id === cellId);
        if (idx === -1) return prev;
        const cell = prev[idx];

        let logs = '';
        const print = (...args: any[]) => {
          logs += args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
          ).join(' ') + '\n';
        };

        try {
          const fn = new Function('engine', 'assertEqual', 'print', cell.code);
          fn(engine, assertEqual, print);

          setExecutionCounter(c => c + 1);
          const newCount = executionCounter + 1;

          const updated = [...prev];
          updated[idx] = {
            ...cell,
            status: 'success',
            executionCount: newCount,
            output: logs || '✅ OK (no output)',
          };
          return updated;
        } catch (e: any) {
          setExecutionCounter(c => c + 1);
          const newCount = executionCounter + 1;

          const updated = [...prev];
          updated[idx] = {
            ...cell,
            status: 'error',
            executionCount: newCount,
            output: (logs ? logs + '\n' : '') + '❌ ' + (e.message || String(e)),
          };
          return updated;
        }
      });
    }, 30);
  }, [getEngine, executionCounter]);

  const runAllCells = useCallback(async () => {
    setIsRunningAll(true);
    const engine = getEngine();

    let counter = executionCounter;
    const updatedCells = [...cells];

    for (let i = 0; i < updatedCells.length; i++) {
      const cell = updatedCells[i];

      if (cell.type === 'markdown') {
        updatedCells[i] = { ...cell, status: 'success', output: '', executionCount: null };
        continue;
      }

      let logs = '';
      const print = (...args: any[]) => {
        logs += args.map(a =>
          typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' ') + '\n';
      };

      try {
        const fn = new Function('engine', 'assertEqual', 'print', cell.code);
        fn(engine, assertEqual, print);
        counter++;
        updatedCells[i] = {
          ...cell,
          status: 'success',
          executionCount: counter,
          output: logs || '✅ OK (no output)',
        };
      } catch (e: any) {
        counter++;
        updatedCells[i] = {
          ...cell,
          status: 'error',
          executionCount: counter,
          output: (logs ? logs + '\n' : '') + '❌ ' + (e.message || String(e)),
        };
        // Stop execution on error, like Colab's default
        break;
      }

      // Yield to UI between cells
      setCells([...updatedCells]);
      await new Promise(r => setTimeout(r, 50));
    }

    setExecutionCounter(counter);
    setCells([...updatedCells]);
    setIsRunningAll(false);
  }, [cells, executionCounter, getEngine]);

  const restartRuntime = useCallback(() => {
    engineRef.current = createEditorEngine();
    setExecutionCounter(0);
    setCells(prev =>
      prev.map(c => ({ ...c, output: '', status: 'idle' as CellStatus, executionCount: null }))
    );
  }, []);

  const clearAllOutputs = useCallback(() => {
    setCells(prev =>
      prev.map(c => ({ ...c, output: '', status: 'idle' as CellStatus, executionCount: null }))
    );
  }, []);

  // ── Cell Management ──────────────────────────────────────────────────────

  const updateCellCode = useCallback((id: string, code: string) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, code } : c));
  }, []);

  const addCellBelow = useCallback((id: string) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      const newCells = [...prev];
      newCells.splice(idx + 1, 0, createCell());
      return newCells;
    });
  }, []);

  const deleteCell = useCallback((id: string) => {
    setCells(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter(c => c.id !== id);
    });
  }, []);

  const moveUp = useCallback((id: string) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx <= 0) return prev;
      const newCells = [...prev];
      [newCells[idx - 1], newCells[idx]] = [newCells[idx], newCells[idx - 1]];
      return newCells;
    });
  }, []);

  const moveDown = useCallback((id: string) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx === -1 || idx >= prev.length - 1) return prev;
      const newCells = [...prev];
      [newCells[idx], newCells[idx + 1]] = [newCells[idx + 1], newCells[idx]];
      return newCells;
    });
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCells(prev => prev.map(c =>
      c.id === id ? { ...c, collapsed: !c.collapsed } : c
    ));
  }, []);

  const toggleType = useCallback((id: string) => {
    setCells(prev => prev.map(c =>
      c.id === id ? { ...c, type: (c.type === 'code' ? 'markdown' : 'code') as CellType } : c
    ));
  }, []);

  // ── Effects ──────────────────────────────────────────────────────────────

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
              style={[styles.tab, activeTab === "notebook" && styles.activeTab]} 
              onPress={() => setActiveTab("notebook")}
            >
              <Text style={[styles.tabText, activeTab === "notebook" && styles.activeTabText]}>Notebook</Text>
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
            {/* Notebook toolbar */}
            <View style={nb.toolbar}>
              <TouchableOpacity
                style={[nb.toolbarBtn, nb.toolbarBtnPrimary]}
                onPress={runAllCells}
                disabled={isRunningAll}
              >
                <Text style={nb.toolbarBtnText}>
                  {isRunningAll ? '⏳ Running...' : '▶▶ Run All'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[nb.toolbarBtn, nb.toolbarBtnDanger]}
                onPress={restartRuntime}
              >
                <Text style={nb.toolbarBtnText}>⟳ Restart Runtime</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[nb.toolbarBtn, nb.toolbarBtnSecondary]}
                onPress={clearAllOutputs}
              >
                <Text style={nb.toolbarBtnTextDark}>Clear Outputs</Text>
              </TouchableOpacity>
            </View>

            {/* Engine status bar */}
            <View style={nb.engineStatus}>
              <Text style={nb.engineStatusText}>
                🟢 Runtime connected  ·  Executions: {executionCounter}
              </Text>
            </View>

            {/* Cells */}
            <ScrollView
              style={{ flex: 1 }}
              keyboardShouldPersistTaps="handled"
            >
              {cells.map((cell, index) => (
                <CellComponent
                  key={cell.id}
                  cell={cell}
                  index={index}
                  totalCells={cells.length}
                  isRunningAll={isRunningAll}
                  onCodeChange={updateCellCode}
                  onRun={runCell}
                  onDelete={deleteCell}
                  onMoveUp={moveUp}
                  onMoveDown={moveDown}
                  onToggleCollapse={toggleCollapse}
                  onAddBelow={addCellBelow}
                  onToggleType={toggleType}
                />
              ))}
              {/* Bottom spacer for keyboard */}
              <View style={{ height: 120 }} />
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Test Suite Styles ───────────────────────────────────────────────────────

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
});

// ─── Notebook Styles ─────────────────────────────────────────────────────────

const nb = StyleSheet.create({
  // Toolbar
  toolbar: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  toolbarBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  toolbarBtnPrimary: {
    backgroundColor: '#4caf50',
  },
  toolbarBtnDanger: {
    backgroundColor: '#f44336',
  },
  toolbarBtnSecondary: {
    backgroundColor: '#e0e0e0',
  },
  toolbarBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  toolbarBtnTextDark: {
    color: '#333',
    fontWeight: '700',
    fontSize: 13,
  },

  // Engine status
  engineStatus: {
    backgroundColor: '#e8f5e9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginBottom: 12,
  },
  engineStatusText: {
    fontSize: 12,
    color: '#2e7d32',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Cell
  cellWrapper: {
    marginBottom: 4,
  },
  cell: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderColor: '#e0e0e0',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    overflow: 'hidden',
  },

  // Cell header
  cellHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#fafafa',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  cellHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cellHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  runBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#e8f5e9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  runBtnText: {
    fontSize: 14,
  },
  execCount: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    fontWeight: '600',
    minWidth: 30,
  },
  typeToggle: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#e3f2fd',
    borderRadius: 4,
  },
  typeToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1976d2',
  },
  headerIconBtn: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
  },
  headerIconText: {
    fontSize: 14,
    color: '#666',
  },
  disabledBtn: {
    opacity: 0.3,
  },

  // Code input
  codeInput: {
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  markdownInput: {
    backgroundColor: '#fff',
    color: '#333',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },

  // Output
  outputContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  outputSuccess: {
    backgroundColor: '#f8f9fa',
  },
  outputError: {
    backgroundColor: '#fff3f3',
  },
  outputText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#333',
    lineHeight: 18,
  },

  // Add cell button
  addCellBtn: {
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    borderStyle: 'dashed',
  },
  addCellBtnText: {
    fontSize: 12,
    color: '#888',
    fontWeight: '600',
  },
});
