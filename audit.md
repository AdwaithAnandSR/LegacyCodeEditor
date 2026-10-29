# LegacyCodeEditor: bug and performance audit

Oct 28, 2026 · @Adwaith Anand Sr

Constant 60 fps is not reachable with the current design: every scroll event, cursor blink and keystroke rebuilds the whole Skia picture on the JS thread, and the engine does work proportional to document size on every keystroke. Three bugs matter most: Backspace past the typed text inserts 99 invisible characters, non-ASCII text corrupts because the engine counts UTF-8 bytes while JS counts UTF-16 units, and tab-indented lines misplace the cursor.

## What I measured

I compiled the real `HybridEditorEngine.hpp`, `SyntaxEngine.cpp` and the vendored tree-sitter on Linux (only the Nitro spec header is stubbed), then ran correctness and timing tests. Timings are x86 at -O2 with NDEBUG; a phone will differ, so read them as ratios and growth rates, not absolute frame budgets.

| Test | Result |
| --- | --- |
| Typing 3,000 characters into a 100 KB file | 322 MB resident memory; the undo stack holds 3,000 full copies of the document |
| One keystroke, nested code, 2,200 lines (50 KB) | 0.31 ms |
| One keystroke, nested code, 55,000 lines (1.2 MB) | 13 ms |
| One keystroke, flat top-level statements, 5,000 lines (0.3 MB) | 17 ms |
| One keystroke, flat top-level statements, 20,000 lines (1.2 MB) | 79 ms, of which 75 ms is the tree-sitter reparse |
| Per-keystroke line-cache rebuild (runs twice per insert) | 1.0 ms at 1.2 MB, 5.6 ms at 6.3 MB |
| `getSyntaxTokens` for a 45-line viewport | 0.39 ms and 368 tokens per call, every frame |
| Same call with the viewport inside a 20,000-line block comment | 20,002 tokens returned for 46 visible lines |
| `loadContent` on 100,000 lines (6.3 MB), including the full parse | 1,129 ms; `undo()` on the same file 1,380 ms |
| `findText("a")` on 50,000 lines | 200,000 hits in 18.9 s |
| Insert `é`, then JS-style Backspace | Invalid UTF-8 left in the document |
| Fuzzed edits (7,200 checkpoints) vs a fresh parse | 0 wrong highlight tokens, so incremental edits are sound |
| `indentLine`, `insertLine`, `findAndReplace` | Syntax tree left stale; the tree is never told about these edits |

The Backspace defect comes from a line-for-line port of `handleTextChange` driven by a simulated text field (caret at the end, `setNativeProps` honoured). It reproduces the logic, not a real Android keyboard, so confirm it on a device.

## Bugs

Ranked by how soon a user hits them. Items 1 and 2 reproduce in my tests; the rest are read directly from the code unless noted.

| # | Severity | Where | What happens | Recommended fix |
| --- | --- | --- | --- | --- |
| 1 | Critical | `useEditorInput.ts` lines 86-95 | Tap, then Backspace (or hold Backspace past the text typed since the last reset): the field holds a 99-character prefix of the sentinel, which the code treats as tampering. It inserts 99 zero-width characters and deletes nothing. Simulated, not yet seen on a device. | Treat any pure deletion (new text is a prefix of the previous text) as `prev.length - text.length` backspaces. Re-arm the sentinel when it drops below about 50 characters. |
| 2 | Critical | `HybridEditorEngine.hpp` `toOffset`, `toPosition`, `getLineLength`; `SyntaxEngine.cpp` token columns | Engine columns are UTF-8 bytes; JS uses UTF-16 units and `column * charWidth`. Backspace after `é` deletes one byte and leaves invalid UTF-8; Arrow-right lands inside a character; an emoji advances 4 columns for 2 units; highlight spans shift. Reproduced. | Make engine columns UTF-16 units: convert in `toOffset` and `toPosition`, and convert tree-sitter byte columns when emitting tokens. Add engine-side `deleteBackward` and `deleteForward` that remove whole code points. |
| 3 | High | `SkiaRenderer.ts` tab expansion vs `EditorStateManager.ts` `getCursorX`, `getLineColumn`, selection drawing | Tabs are drawn as 4 spaces, but cursor, selection and taps use the raw column. On a tab-indented line the cursor sits 3 cells left per tab and taps land in the wrong column. | One `columnToVisual(line, col)` and `visualToColumn` pair with real tab stops, used by renderer, cursor, selection, hit-testing and token mapping. |
| 4 | High | `SkiaRenderer.ts` text pass (no `clipRect` anywhere in `src`) | When scrolled right, text with up to 20 characters of overscan draws over the gutter and the line numbers. | `canvas.clipRect` to the content area for the text pass, or draw the gutter after the text. |
| 5 | Medium | `indentLine(s)`, `outdentLine(s)`, `insertLine`, `deleteLine`, `findAndReplace` | These change the text but never update the syntax tree. Highlighting goes stale and later incremental edits apply to the wrong tree. Reproduced. Not reachable from today's UI. | Route every mutation through one `applyEdit(start, end, text)` that records undo, updates the line index and the tree. |
| 6 | Medium | `toOffset`, `deleteText`, `recordUndo` | Positions are not clamped: a column past the line end writes into the next line. A reversed range still pushes a full undo snapshot and sends tree-sitter an inverted edit (it survived in my run and changed nothing). | Clamp and normalise ranges at every entry point; return before `recordUndo` when the edit is a no-op. |
| 7 | Medium | `maxRenderedLineLength` in `EditorStateManager.ts` | Horizontal scroll range only knows lines already drawn, is never reset by `loadContent`, counts a tab as one column. The scroll limit changes as you scroll vertically and stays wrong after the longest line is deleted. | Engine-maintained maximum line length in visual columns, cached per document version. |
| 8 | Medium | `dispose()`, blink timer, `EditorCanvas.tsx` | `dispose()` leaves a running momentum animation alive. The blink timer keeps redrawing in the background and with the keyboard hidden. `createPicture(...)` for the shared value's initial value runs on every render. The 10 ms timeout in `focus()` is never cleared. | Cancel animation frames in `dispose()`, pause blink on AppState change and blur, create the initial picture once. |
| 9 | Medium | `FloatingMenu.tsx`, `EditorStateManager.ts`, `useEditorInput.ts` | Paste does not scroll the cursor into view. Arrow keys ignore an active selection. `deleteForward` does not scroll. Tab inserts a hard-coded 4 spaces and ignores `tabSize` and `insertSpaces`. Cut and paste write to the engine directly, bypassing the state manager. | Route cut, paste and keys through state-manager methods; read indentation settings from the engine. |
| 10 | Low | `undo()` and `computeHash` | Undoing past the saved state leaves `modified` false (reproduced). The DJB2 hash uses `unsigned long`, 32-bit on armeabi-v7a, so collisions can hide real changes. | Compare a saved version number instead of hashing the whole document. |
| 11 | Low | `isWordChar`, `findText` | Word selection is ASCII-only. Case-insensitive search calls `::tolower` on a signed `char`, which is undefined for bytes at or above 0x80. `std::regex` can recurse deeply on the JS thread. | Unicode-aware word class, cast to `unsigned char`, and cap or time-box regex search. |
| 12 | Low | `adjustTokensForTabs` and the filter after it | Which of two captures on one node wins depends on tree-sitter's undocumented capture order. Today `function` comes before `variable` (checked), so function names are coloured, but a library update can flip it. | Resolve priority and de-duplicate in C++ by pattern index. |
| 13 | Low | `rn-config.json`, `metro.config.js`, `package.json`, `app.json` | `rn-config.json` is a build artifact with absolute `/data/data/com.termux/...` paths. `metro.config.js` replaces Metro's `blockList` instead of extending it. `react-native-mmkv`, `@expo/ui`, `expo-symbols`, `expo-web-browser`, `react-native-web` and `react-dom` are unused. `reactCompiler` is on while `FloatingMenu` and `useEditorInput` mutate `stateManager` during render, which the compiler rejects (not run). | Delete the artifact, extend the default blockList, drop unused packages, move render-time mutations into effects. |

The input fix for item 1, in outline:

```ts
// pure deletion: new text is a prefix of the old text
if (prevStr.startsWith(text) && text.length < prevStr.length) {
  stateManager.backspace(prevStr.length - text.length);
  lastTextRef.current = nativeTextRef.current = text;
  if (text.length < 50) clearInput(); // re-arm the sentinel
  return;
}
```

## Performance defects: render and gesture path

The biggest frame-rate problems are structural (R1 to R3). I could not profile Skia or Hermes in this environment, so the cost of R1, R2 and R6 is from reading the code and from the native numbers above, not from a device trace.

| # | Defect | Evidence | Recommended fix |
| --- | --- | --- | --- |
| R1 | The whole picture is re-recorded on every invalidate, synchronously, on the JS thread, with no coalescing | `invalidate()` calls `createEditorPicture` immediately. Pan updates, momentum ticks, `animateScrollTo` ticks, blink and handle drags all call it, and one action can call it 2 to 3 times (`scrollToCursor` starts an animation, then `invalidate()` runs). Each result is assigned to a Reanimated shared value, crossing to the UI runtime. | Set a dirty flag and draw at most once per animation frame. Longer term, stop re-recording on scroll at all (see the architecture section). |
| R2 | Scrolling runs on the JS thread | All three gestures use `.runOnJS(true)`, and momentum is a JS `requestAnimationFrame` loop. Any JS stall (GC, a picture build, a React render) drops frames, and touch events queue behind the picture build. | UI-thread worklet gestures that write a shared value, and `withDecay` for momentum. |
| R3 | Cursor blink re-records the entire picture every 530 ms, forever | `startBlink` calls `invalidate()`, which rebuilds the picture, re-queries tokens and notifies React listeners, even in the background. | Draw the cursor as a separate overlay whose opacity is animated on the UI thread. Stop it when blurred or backgrounded. |
| R4 | Lines and tokens are refetched on every frame | `getSyntaxTokens` returns 368 objects per call and `getLine` runs 46 times, on frames where the text did not change. The engine exposes no document version to key a cache. | Add a `version` counter to the engine. Cache lines and tokens for the viewport plus 30 lines either side. Return tokens as a packed typed array, not an object array. |
| R5 | A multi-line token emits one segment per line of the token, visible or not | In the C++ `getSyntaxTokens` loop, a viewport inside a 20,000-line block comment returned 20,002 tokens for 46 visible lines. | Clamp the row loop to the requested line range in C++. |
| R6 | Horizontal scroll misses the paragraph cache on every visible line | The slice starts at `floor(scrollX / charWidth) - 20`. Each time the scroll crosses a character, every sliced string changes, so every visible line builds and lays out a new Paragraph, roughly 46 per frame at normal swipe speed. | Align the slice start to 64-column chunks, or draw the whole line when it is under about 400 columns and translate it. |
| R7 | Paragraph cache wastes memory and hitches | Paragraph is Skia's heaviest text API. The key is the full line text plus a token string, so every keystroke adds an entry that is never reused. The whole cache is cleared at 5,000 line entries and 1,000 number entries, and JS cannot see the native size of each paragraph. | LRU of about 400 entries keyed by line and version. For monospace text, draw cached glyph runs or text blobs per token and keep Paragraph only for non-ASCII fallback. |
| R8 | React overlay is notified every frame | `invalidate()` always calls `notifyUI()`, which builds a snapshot string per listener per frame. `FloatingMenu` unmounts and remounts with Reanimated layout animations at every scroll start and stop, and mutates `stateManager` while rendering. | Notify only when selection or menu state changes. Keep the menu mounted and animate its opacity with a shared value. |
| R9 | Native calls repeated inside one frame | Selection drawing calls `getLineLength` per selected visible line. `maxScrollX` and `maxScrollY` read `engine.lineCount` several times per scroll event. | Cache `lineCount` and line lengths per document version. |
| R10 | Per-frame JS allocation | Cache-key strings, token copies in `adjustTokensForTabs`, `sort` and `filter`, `Skia.Color(hex)` on each style push, a new `scrollOffset` object per move. A V8 microbenchmark of this logic took 0.084 ms per frame, so it is minor next to R1 to R6 (Hermes is slower; not measured). | Precomputed colours; cache the processed line with its tokens. |
| R11 | Selection drag restarts a 200 ms scroll animation on every move event | `handleSelectionUpdate` and `handleHandleDrag` call `scrollToCursor`, which calls `animateScrollTo`, which stops and restarts the animation each time. There is no constant-speed edge auto-scroll. | Velocity-based auto-scroll while the finger is inside an edge band. |

## Performance defects: editor-engine (C++)

On ordinary files (a few thousand lines of nested code) a keystroke costs 0.3 ms and the engine is not your frame-rate problem. It becomes one on large files, flat files and long sessions, and E1 will eventually kill the app with an out-of-memory error. All timings are measured; see the measurements section for the conditions.

| # | Defect | Evidence | Recommended fix |
| --- | --- | --- | --- |
| E1 | Undo stores a full copy of the document on every edit, with no limit | 322 MB resident after 3,000 keystrokes in a 100 KB file; a 1 MB file would pass 3 GB. `getExternalMemorySize` reports only the text length, so the JS GC cannot see it. | Store inverse edits (offset, removed text, inserted text). Merge typing runs into one step. Cap by bytes. Report the real size. Undo applies the inverse edit instead of reloading and reparsing. |
| E2 | The tree-sitter reparse grows with file size and runs on the JS thread with no timeout | 17 ms at 5,000 flat lines, 79 ms at 20,000, 13 ms at 55,000 nested lines. On flat files an incremental reparse costs roughly a third of a full parse (extrapolated from the 100,000-line load). I did not isolate why reuse is poor there. | Call `ts_tree_edit` immediately (cheap) and reparse about 50 ms after the last edit, on a background thread with `ts_parser_set_timeout_micros`. Draw tokens from the edited old tree meanwhile; briefly stale colours are acceptable. |
| E3 | The line index is rebuilt from scratch, byte by byte, twice per insert | 1.0 ms at 1.2 MB and 5.6 ms at 6.3 MB, each time. | Update line starts incrementally, shifting later offsets through a Fenwick tree, or use a piece tree that stores line-feed counts. Use `memchr` for scanning. |
| E4 | Adjacent pieces are never merged, so every keystroke adds a piece | Typing into a 12 KB file: 15 us per operation at the start, 102 us after 40,000 inserts, growing linearly. `length()`, `findPieceAtOffset`, `getChunkAtOffset` and `remove` are all O(pieces); `remove` rebuilds the whole vector. | Extend the previous piece when the new text is contiguous in the add buffer. Cache the total length. Use a tree or binary search over cumulative offsets. Compact the add buffer when idle. |
| E5 | `toPosition` scans lines linearly from the end | 0.117 ms per call at 100,000 lines, and each edit calls it three times. | `std::upper_bound` over the line starts. |
| E6 | `findText` copies the document and calls `toPosition` per hit | 200,000 hits on 50,000 lines took 18.9 s, blocking JS. | One pass that tracks line and column. Cap results at about 10,000. Run in chunks or off-thread. |
| E7 | Load, undo and `applyEdits` do a full parse on the JS thread | 1.1 s to load 6.3 MB; undo 1.4 s. `applyEdits` also rebuilds the line index once per edit. | Parse after first paint, with a timeout. Above a size threshold, turn highlighting off or run it viewport-only. |
| E8 | `getLine`, `getLineLength` and `clampPosition` copy a whole line to read its length | One minified 1 MB line means every cursor move copies 1 MB. | O(1) length from the line starts (allowing for CR). Add a batch `getLines(first, last)` call and use it in the renderer. |
| E9 | Tokens cross the bridge as one object each | A `std::string` per token in C++, then JS objects: 368 per frame in the 45-line test. | Return one packed `Int32Array` of line, start column, end column and type id, with the type names sent once. |
| E10 | `findMatchingBracket` copies the whole document per call and ignores strings and comments | Unused today, O(document) when wired up. | Scan outward through a piece cursor with a window limit, or use the tree. |
| E11 | Native build flags | `cppFlags` in `build.gradle` apply to C++ only, so the tree-sitter C files may get no `-O2` (unverified; check the build log). Release also carries `-fstack-protector-all`, and the debug variant is `-O1 -g`. The Termux paths in `rn-config.json` suggest on-device builds. | Add `cFlags "-O2"` and `-DNDEBUG` for release, drop the stack protector there, and profile release builds only. |

## Recommended architecture for constant 60 fps

The rule: scrolling, momentum, cursor blink and handle dragging must cost no JS-thread work per frame. JS runs only when the text, the selection or the recorded window changes. Small fixes to the current code (coalescing, caches) help, but only this change removes the dependence on the JS thread, because any JS stall drops a scroll frame today.

1. **Scroll on the UI thread.** Keep `scrollX` and `scrollY` as Reanimated shared values. Write the pan gestures as worklets (no `runOnJS`) and use `withDecay` for momentum, clamped by shared `maxScrollX` and `maxScrollY` that JS updates when the document changes.
2. **Record a window, not a frame.** Record lines from 30 above to 30 below the viewport into one picture at absolute document coordinates, with the gutter and the text in separate pictures. Show them in a `Group` translated by the shared scroll values, with a clip for the content area. Re-record only when the document version changes, the viewport leaves the recorded window (about every 30 lines of scroll), or the selection changes. Slice long lines in 64-column chunks so the horizontal window is stable.
3. **Separate cheap layers for what moves.** Draw the cursor as its own rectangle whose opacity is animated on the UI thread, and the selection rectangles, handles and current-line highlight as small overlays driven by shared values. Blink then costs nothing in JS.
4. **One data fetch per re-record.** Add a document `version` to the engine. On a re-record, call `getLines(first, last)` once and fetch one packed token buffer clamped to that range. No Nitro calls happen in scroll frames.
5. **Cheaper text drawing.** Cache glyph runs or text blobs per token for monospace text, in an LRU keyed by line and version. Keep Paragraph for non-ASCII fallback.
6. **Make the keystroke path small.** Fix E1 to E4 so an edit is a small inverse-edit record, an incremental line-index update and a merged piece. Apply `ts_tree_edit` immediately and reparse after a short pause, off the typing path.
7. **Measure on a release build.** Log the time of each re-record and of each engine call, and capture frame times with Perfetto or `adb shell dumpsys gfxinfo`.

| Work per frame | Today | Target |
| --- | --- | --- |
| Scroll frame, JS thread | Full picture re-record, 46 `getLine` calls, token fetch, \~370 objects | None (re-record about every 30 lines) |
| Cursor blink, JS thread | Full re-record every 530 ms | None |
| Momentum scroll | JS `requestAnimationFrame` loop | `withDecay` on the UI thread |
| Keystroke | Document copy, two line-index rebuilds, reparse on the JS thread | Inverse-edit record, incremental index, deferred reparse; under 8 ms on a 50,000-line file |

I have not confirmed that Skia 2.6.2 and Reanimated 4.5.1 accept shared values for `Group` transforms in this setup. Check the Skia docs for your versions before committing to step 2. If they do not, drive the transform through a picture-level `useDerivedValue`, which keeps steps 1 and 3 intact.

## Fix order

The first three steps stop data loss and crashes. Steps 4 to 6 are cheap and give visible smoothness. Step 7 is the large change that reaches constant 60 fps.

1. **Backspace in `useEditorInput.ts` (bug 1).** Small change, prevents invisible junk in every document.
2. **UTF-16 columns and whole-code-point delete in the engine (bug 2).** Medium. Stops text corruption and misplaced highlighting for any non-ASCII file.
3. **Inverse-edit undo (E1) and piece merging (E4).** Medium. Removes the out-of-memory path and the slow growth in long sessions.
4. **Coalesce `invalidate()` into one draw per animation frame, stop the blink re-record, cancel timers in `dispose()` (R1, R3, bug 8).** Small.
5. **Clip the text pass and fix tab columns (bugs 3 and 4).** Small to medium.
6. **Engine `version`, batch `getLines`, packed and clamped tokens (R4, R5, E8, E9).** Medium. Removes the per-frame native work.
7. **UI-thread scroll and window recording (architecture steps 1 to 3, R2, R6, R7).** Large. This is what makes scrolling independent of the JS thread.
8. **Deferred reparse, incremental line index, binary-search `toPosition` (E2, E3, E5, E7).** Medium. Matters for files above roughly 5,000 lines.
9. **The rest:** bugs 5 to 13, E6, E10, E11, R8 to R11.

The Linux test harness I built compiles the real engine with a stubbed Nitro header and runs the correctness and timing tests above. Turning it into a regression suite is the cheapest way to check steps 2, 3 and 8 as you make them; say if you want it packaged.

## Not verified

- **No device run.** Skia, Hermes and Nitro marshalling costs behind R1 to R10 are inferred from the code and the native timings, not traced on a phone.
- **`tsc` and `expo lint` did not run.** The dependency install crashed repeatedly in this environment, so type errors and React Compiler lint findings are unknown. Check the deep type import of `ComposedGestureType` in `useEditorScroll.ts` first.
- **Backspace bug (1) is a simulation.** The real keyboard's caret position after `setNativeProps({ text })`, and whether Fabric applies that text, may differ.
- **Character width.** `charWidth` comes from one "M" via `getMinIntrinsicWidth`. If the platform rounds glyph advances, the cursor drifts on long lines; measure 100 characters and divide to check.
- **Timings are x86.** A phone will be slower; the growth with file size and session length still holds.
- **Build flags (E11)** are read from the Gradle and CMake files, not from a build log. iOS was only checked through the podspec.
