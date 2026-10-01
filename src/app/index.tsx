import { StyleSheet, View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { EditorCanvas } from "@/editor";

const SAMPLE_CODE = `// Welcome to LegacyCodeEditor

function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const result = fibonacci(10);
console.log("Fibonacci(10) =", result);

`;

import { KeyboardAvoidingView, Platform } from "react-native";

export default function EditorScreen() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar style="light" />

        {/* Header bar */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>LegacyCodeEditor</Text>
        </View>

        {/* Editor takes all remaining space */}
        <KeyboardAvoidingView 
          style={styles.editorContainer} 
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <EditorCanvas initialContent={SAMPLE_CODE} />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#1E1E1E",
  },
  safe: {
    flex: 1,
    backgroundColor: "#1E1E1E",
  },
  header: {
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333",
  },
  headerTitle: {
    color: "#CCCCCC",
    fontSize: 16,
    fontWeight: "600",
  },
  editorContainer: {
    flex: 1,
  },
});
