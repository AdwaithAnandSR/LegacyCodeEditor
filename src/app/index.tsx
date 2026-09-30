import React, { useState, useEffect, useRef } from "react";
import { StyleSheet, View, Text as RNText, TextInput } from "react-native";
import { createEditorEngine, CursorPosition } from "editor-engine";
import { Canvas, Paragraph, useFonts, Skia } from "@shopify/react-native-skia";

export default function App() {
    // 1. Initialize Engine (No useMemo needed. useRef keeps the class instance alive)
    const engineRef = useRef<any>(null);
    if (!engineRef.current) {
        engineRef.current = createEditorEngine();
        engineRef.current.loadContent("");
    }
    

    
    const fontMgr = useFonts({
        SpaceMono: [require("../../assets/fonts/SpaceMono-Regular.ttf")]
    });

    
    const handleTextChange = (text: string) => {
        
    };

    const handleKeyPress = ({ nativeEvent }: any) => {
        
    };

    if (!fontMgr) {
        return (
            <View style={styles.container}>
                <RNText style={{ color: "white" }}>Loading...</RNText>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <RNText style={styles.title}>Nitro x Skia Engine</RNText>

            

            <View style={styles.editorPreview}>
                <Canvas style={StyleSheet.absoluteFill}>
                    
                        <Paragraph />
                    
                </Canvas>

                <TextInput
                    style={styles.ghostInput}
                    value=""
                    onChangeText={handleTextChange}
                    onKeyPress={handleKeyPress}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    autoComplete="off"
                    caretHidden={true}
                    multiline={false}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#1E1E1E",
        padding: 30,
        paddingTop: 60
    },
    title: {
        color: "#FFFFFF",
        fontSize: 22,
        marginBottom: 15,
        fontWeight: "bold"
    },
    statsContainer: {
        flexDirection: "row",
        justifyContent: "space-between",
        marginBottom: 10,
        paddingHorizontal: 5
    },
    statText: { color: "#858585", fontSize: 12, fontFamily: "monospace" },
    editorPreview: {
        flex: 1,
        backgroundColor: "#252526",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#333",
        overflow: "hidden"
    },
    ghostInput: {
        ...StyleSheet.absoluteFillObject,
        color: "transparent",
        backgroundColor: "transparent"
    }
});
