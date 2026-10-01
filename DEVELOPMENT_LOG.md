# Legacy Code Editor: Development Log

This document chronicles the chronological development journey of the code editor, detailing the architectural decisions, technological choices, and problem-solving strategies employed to build a high-performance mobile-first code editor.

## 1. Project Initialization & Expo Setup

**What was implemented:**
The project was bootstrapped as an Expo/React Native mobile application utilizing Expo Router for navigation. Core tooling including TypeScript and ESLint was set up.

**Relevant technologies:**
- Expo SDK 57
- React Native 0.86
- Expo Router
- TypeScript

## 2. Nitro Module Initialization

**What was implemented:**
A custom native module named `editor-engine` was initialized using `react-native-nitro-modules`. The module was configured for both iOS and Android (with CMake).

**Why it was needed:**
Text editing on mobile, especially for code, requires extreme performance for large documents. A pure JavaScript implementation would suffer from garbage collection pauses and string manipulation bottlenecks. Nitro Modules provide zero-overhead synchronous C++ interoperability.

**Important technical decisions:**
- Used `react-native-nitro-modules` instead of traditional JSI/TurboModules for faster and simpler C++ bindings.
- Defined a strict interface in `EditorEngine.nitro.ts` to generate C++ bridging code automatically (`nitrogen`).

## 3. Native/C++ Editor Engine Creation

**What was implemented:**
A highly optimized core text engine written entirely in C++ (`HybridEditorEngine.cpp/hpp`).

**Important architectural decisions:**
- **Piece Table Data Structure:** Instead of storing text as a contiguous string or array of lines, the engine uses a Piece Table. Insertions go into an "add buffer," and the document is represented as a sequence of "pieces" referencing spans in either the original or add buffer. This makes insertions and deletions O(pieces) and keeps the original text immutable, which is crucial for handling massive files efficiently.
- **Undo/Redo Stack:** Built a native `UndoManager` that stores snapshots/diffs of the Piece Table, allowing infinite undo/redo capabilities synchronously.
- **Line Cache:** A cache of line start byte offsets (`lineStartOffsets_`) was implemented to quickly convert between `(line, column)` coordinates and absolute byte offsets without scanning the whole document.

## 4. React Native ↔ C++ Integration

**What was implemented:**
The C++ `HybridEditorEngine` was exposed to JavaScript via Nitro. The React Native app initializes this engine as a Hybrid Object.

**Problems encountered:**
- Encountered a "double registering" bug where the native module was initialized multiple times, which was fixed to ensure a singleton-like lifecycle per editor instance.

## 5. Editor Rendering and Skia Integration

**What was implemented:**
The entire UI rendering of the code editor was moved away from React's declarative tree to a pure imperative GPU rendering pipeline using `@shopify/react-native-skia`.

**Why it was needed:**
Rendering hundreds of lines of text using React Native `<Text>` components causes severe layout thrashing and scrolling lag. Drawing directly to a Skia canvas guarantees consistent 60/120fps.

**Important architectural decisions:**
- **Bypassing React:** `EditorCanvas.tsx` uses a Reanimated `SharedValue` holding an `SkPicture`. When the editor needs to redraw, it imperatively records draw commands and updates the shared value. The GPU repaints automatically without triggering a React re-render.
- **Paragraph Caching:** Skia `ParagraphBuilder` is fast, but doing it for every line, 120 times a second, bottlenecks the JS thread. Implemented `lineParagraphCache` and `lineNumberCache` in `SkiaRenderer.ts` to memoize text layouts.

## 6. Editor State Architecture

**What was implemented:**
Created `EditorStateManager.ts` as the mutable, imperative core of the editor.

**Why it was needed:**
To support the React-bypassing Skia rendering pipeline, state could not be stored in React `useState`.

**Important architectural decisions:**
- Separated "what to draw" (`EditorStateManager` storing cursor, scroll offset) from "how to draw" (`SkiaRenderer` making Skia paint calls).
- The state manager directly communicates with the C++ Nitro engine to apply edits and retrieve text, then calls an `invalidate()` callback to tell Skia to repaint.

## 7. Cursor and Text Interaction (The Sentinel Algorithm)

**What was implemented:**
`useEditorInput.ts` captures user typing using a hidden `<TextInput>`.

**Significant problems encountered:**
- **Android Keyboard Buffer Desync:** Android keyboards heavily rely on their internal state. When the editor moved the cursor programmatically, attempting to clear the hidden `TextInput`'s buffer (`clearInput()`) was often asynchronously ignored by Android, leading to text duplication (e.g., "The Duplicate hhahai Typing Bug").
- **Grapheme Deletion Bugs:** Attempting to use Zero-Width Joiner (`\u200D`) characters for the hidden input caused Android backspace to chunk-delete 4 characters at once.

**How they were solved:**
- Switched to completely safe invisible characters: `\u200B` (Zero Width Space) and `\u200C` (Zero Width Non-Joiner).
- **Alternating-Sentinel Desync Recovery Algorithm:** Instead of fighting the OS to clear the input, the hidden input alternates between two 100-character invisible strings (`SENTINEL_A` and `SENTINEL_B`). When the user types, the hook diffs the new text against the *last known sentinel* or the *true OS buffer*, perfectly recovering the user's intended keystrokes or backspaces regardless of Android's internal buffer state.

## 8. Gesture Handling and Physics Engine

**What was implemented:**
Replaced standard ScrollViews with a custom gesture handling pipeline using `react-native-gesture-handler` (`useEditorScroll.ts`).

**Important architectural decisions:**
- **Custom Momentum Scrolling:** Built a bespoke physics engine inside `EditorStateManager` using `requestAnimationFrame` to compute standard mobile deceleration friction (approx 0.998 per ms) independently of native UI threads.
- **Directional Locking:** Implemented logic to lock scrolling to either the X or Y axis depending on the initial flick direction.

**Significant problems encountered:**
- **Snap-back flick:** When locking an axis, snapping the inactive axis back to 0 caused a visual jump. Fixed by freezing the inactive axis at its current sub-pixel offset exactly when the lock engages.

## 9. Virtualization (Vertical and Horizontal)

**What was implemented:**
Mathematical culling of off-screen text.

**Why it was needed:**
Drawing thousands of lines to a Skia canvas, even if off-screen, wastes GPU cycles.

**How it was solved:**
- **Vertical Virtualization:** `EditorStateManager` computes `firstLine` and `lastLine` based on `scrollOffset.y`. The Skia render loop only iterates over this specific subset.
- **Horizontal Virtualization:** Dynamically measures the `charWidth`. If a line is scrolled far to the right, `substring()` is used to slice off the invisible left portion of the string before passing it to the Skia Paragraph builder. Added surrogate pair protection to ensure emojis aren't sliced in half during horizontal virtualization.

## 10. Advanced Editor Features

**What was implemented:**
- **Typewriter Mode:** Keeps the cursor centered vertically on the screen while typing, adjusting scroll automatically.
- **Horizontal Auto-scrolling:** The viewport automatically pans horizontally to keep the cursor visible if the user types past the right edge.
- **Scroll Beyond Last Line:** Allows scrolling the document up until the last line is in the middle of the screen, providing comfortable space at the bottom.

---

## Current Architecture State

The editor currently operates as a high-performance hybrid system consisting of three isolated layers:

1. **The Native Layer (C++ / Nitro):** Owns the source of truth for the document text using a Piece Table. It processes all insertions, deletions, search operations, and undo/redo stacks synchronously with zero JS overhead.
2. **The Imperative State Layer (JS):** `EditorStateManager` acts as the orchestrator. It manages the viewport, scroll physics, cursor coordinates, and coordinates interactions between the user's fingers/keyboard and the native C++ engine.
3. **The Presentation Layer (Skia GPU):** `SkiaRenderer` is a pure function that takes the `EditorStateManager` and paints precisely what is visible onto an `SkPicture`. This completely bypasses React's reconciliation cycle, resulting in locked 120fps scrolling and typing regardless of document size.

**What has been implemented so far:**
- Full C++ Piece Table engine with Undo/Redo.
- 120fps GPU-accelerated text rendering with Skia.
- Vertical and Horizontal virtualization.
- Custom momentum scrolling physics and directional locking.
- Flawless keyboard text input using the Alternating-Sentinel algorithm.
- Dynamic auto-scrolling and Typewriter mode.
- Mono font support (`SpaceMono`).
