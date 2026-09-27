import { type HybridObject } from "react-native-nitro-modules";

export interface EditorEngine extends HybridObject<{
    android: "c++";
}> {
    insertText(index: number, text: string): void;
    getText(): string;
}
