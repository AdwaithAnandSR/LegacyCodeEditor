/**
 * SkiaRenderer – pure Skia drawing logic, completely decoupled from React.
 *
 * This module provides a function that records all editor drawing commands
 * into an SkPicture. The Canvas renders this Picture on the GPU.
 *
 * Key design decisions:
 * 1. We use `createPicture()` to imperatively record draw commands, then
 *    render the result via the declarative `<Picture>` component. This
 *    gives us the best of both worlds: imperative drawing + Canvas GPU path.
 * 2. Only visible lines are drawn — the VisibleRange from the state manager
 *    controls this. This is the hook point for virtualisation.
 * 3. Skia Paragraphs are built per-line using ParagraphBuilder.
 *    In the future, syntax highlighting will push multiple styled runs.
 * 4. All Skia Paints are created once (module-level) and reused.
 */

import {
  Skia,
  type SkCanvas,
  type SkPicture,
  PaintStyle,
  type SkPaint,
  type SkPath,
  type SkTypefaceFontProvider,
  type SkParagraph,
  createPicture,
  TextAlign,
} from "@shopify/react-native-skia";
import type { EditorStateManager } from "./EditorStateManager";
import {
  columnToVisual,
  columnToCells,
  expandTabs,
  lineWidthCells,
  setEmojiCells,
  EMOJI_CELLS_MAX,
  snapColumnInText,
} from "./EditorStateManager";
import { EDITOR_THEME } from "./theme";
import type { SyntaxToken } from "editor-engine";

const HORIZONTAL_WINDOW_CAP = 400;

function adjustTokensForTabs(rawLine: string, tokens: SyntaxToken[]): SyntaxToken[] {
  if (!rawLine.includes('\t')) return tokens;

  return tokens.map(token => ({
    ...token,
    startColumn: columnToVisual(rawLine, token.startColumn),
    endColumn: columnToVisual(rawLine, token.endColumn),
  }));
}

/**
 * Compute a fast 32-bit FNV-1a numeric hash over a line's syntax tokens
 * so getCachedLineParagraph never allocates arrays or template strings via .map().join().
 */
function hashLineTokens(tokens: SyntaxToken[] | undefined, safeStart: number): number {
  if (!tokens || tokens.length === 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    h = Math.imul(h ^ (t.startColumn - safeStart), 16777619);
    h = Math.imul(h ^ (t.endColumn - safeStart), 16777619);
    const type = t.tokenType;
    const c0 = type.length > 0 ? type.charCodeAt(0) : 0;
    const c1 = type.length > 1 ? type.charCodeAt(1) : 0;
    h = Math.imul(h ^ ((c0 << 8) | c1), 16777619);
  }
  return h >>> 0;
}

// ── Cached Paints (allocated once at module load) ────────────────────────────

function makePaint(color: string, style: PaintStyle = PaintStyle.Fill): SkPaint {
  const p = Skia.Paint();
  p.setColor(Skia.Color(color));
  p.setStyle(style);
  return p;
}

/** Pre-allocated paints — created once, reused every frame. */
const PAINTS = {
  background: makePaint(EDITOR_THEME.background),
  gutterBg: makePaint(EDITOR_THEME.gutterBackground),
  gutterBorder: makePaint(EDITOR_THEME.gutterBorder),
  currentLineHighlight: makePaint(EDITOR_THEME.currentLineHighlight),
  cursor: makePaint(EDITOR_THEME.cursorColor),
  selectionBg: makePaint(EDITOR_THEME.selectionColor),
  handle: makePaint(EDITOR_THEME.handleColor),
};

// Pre-computed Skia Color values for syntax tokens so Skia.Color() is not called in the inner loop
const SYNTAX_SK_COLORS: Record<string, ReturnType<typeof Skia.Color>> = {
  keyword: Skia.Color(EDITOR_THEME.syntaxColors.keyword),
  function: Skia.Color(EDITOR_THEME.syntaxColors.function),
  string: Skia.Color(EDITOR_THEME.syntaxColors.string),
  number: Skia.Color(EDITOR_THEME.syntaxColors.number),
  comment: Skia.Color(EDITOR_THEME.syntaxColors.comment),
  property: Skia.Color(EDITOR_THEME.syntaxColors.property),
  variable: Skia.Color(EDITOR_THEME.syntaxColors.variable),
  default: Skia.Color(EDITOR_THEME.syntaxColors.default),
};

// A reusable teardrop shape pointing up, commonly used in mobile OS cursors.
// Tip is at (0, -15), arc centers at (0, 0) with radius 10.
const parsedWaterDropPath = Skia.Path.MakeFromSVGString(
  "M 0 -15 L 7.45 -6.66 A 10 10 0 1 1 -7.45 -6.66 Z"
);
if (!parsedWaterDropPath) throw new Error("Failed to parse WATER_DROP_PATH");
const WATER_DROP_PATH: SkPath = parsedWaterDropPath;

// ── Renderer Resources ──────────────────────────────────────────────────────

/**
 * Resources that depend on the font provider.
 * Created once when fonts load and reused every frame.
 */
export interface SkiaRendererResources {
  fontProvider: SkTypefaceFontProvider;
  /** Monospace character width (all chars are the same width). */
  charWidth: number;
}

/**
 * Measure the width of a single monospace character using a Paragraph.
 */
function measureCharWidth(fontProvider: SkTypefaceFontProvider): number {
  const para = Skia.ParagraphBuilder.Make(
    {
      textStyle: {
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: Skia.Color(EDITOR_THEME.textColor),
      },
    },
    fontProvider,
  )
    .addText("M")
    .build();
  para.layout(1e6);
  return para.getMinIntrinsicWidth();
}

/** Width of one emoji in monospace cells, measured with the same text style as the editor. */
function measureEmojiCells(fontProvider: SkTypefaceFontProvider, charWidth: number): number {
  if (!(charWidth > 0)) return 2;
  const para = Skia.ParagraphBuilder.Make(
    {
      textStyle: {
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: Skia.Color(EDITOR_THEME.textColor),
      },
    },
    fontProvider,
  )
    .addText("\u{1F600}")
    .build();
  para.layout(1e6);
  return para.getMinIntrinsicWidth() / charWidth;
}

export function createRendererResources(
  fontProvider: SkTypefaceFontProvider,
): SkiaRendererResources {
  const charWidth = measureCharWidth(fontProvider);
  // setEmojiCells ignores nonsense values and falls back to 2.
  setEmojiCells(measureEmojiCells(fontProvider, charWidth));
  return {
    fontProvider,
    charWidth,
  };
}

// ── Paragraph Caching (Crucial for 120fps scrolling) ────────────────────────

const lineParagraphCache = new Map<string, SkParagraph>();
const lineNumberCache = new Map<string, SkParagraph>();

// Cached gutter picture state: avoids re-recording 80 line number paragraphs on every keystroke
let cachedGutterPicture: SkPicture | null = null;
let cachedGutterKey = "";

function getCachedLineParagraph(
  text: string,
  fontProvider: SkTypefaceFontProvider,
  tokens?: SyntaxToken[],
  safeStart: number = 0,
): SkParagraph {
  const tokenHash = hashLineTokens(tokens, safeStart);
  const cacheKey = tokenHash === 0 ? text : `${text}|${tokenHash}`;

  const existing = lineParagraphCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const builder = Skia.ParagraphBuilder.Make(
    {
      textStyle: {
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: SYNTAX_SK_COLORS.default,
      },
    },
    fontProvider,
  );

  if (!text) {
    builder.addText(" ");
  } else if (!tokens || tokens.length === 0) {
    builder.addText(text);
  } else {
    let currentIdx = 0;
    for (const token of tokens) {
      const tStart = Math.max(0, token.startColumn - safeStart);
      const tEnd = Math.min(text.length, token.endColumn - safeStart);
      
      if (tEnd <= tStart || tStart >= text.length) continue;
      
      if (tStart > currentIdx) {
        builder.pushStyle({
          fontSize: EDITOR_THEME.fontSize,
          fontFamilies: [EDITOR_THEME.fontFamily],
          color: SYNTAX_SK_COLORS.default,
        });
        builder.addText(text.substring(currentIdx, tStart));
        builder.pop();
      }
      
      const skColor = SYNTAX_SK_COLORS[token.tokenType] ?? SYNTAX_SK_COLORS.default;
      builder.pushStyle({
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: skColor,
      });
      builder.addText(text.substring(tStart, tEnd));
      builder.pop();
      
      currentIdx = tEnd;
    }
    
    if (currentIdx < text.length) {
      builder.pushStyle({
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: SYNTAX_SK_COLORS.default,
      });
      builder.addText(text.substring(currentIdx));
      builder.pop();
    }
  }

  const para = builder.build();
  para.layout(1e6); // no wrapping
  
  lineParagraphCache.set(cacheKey, para);
  if (lineParagraphCache.size > 600) {
    const oldestKey = lineParagraphCache.keys().next().value;
    if (oldestKey !== undefined) lineParagraphCache.delete(oldestKey);
  }
  return para;
}

function getCachedLineNumberParagraph(
  lineNum: number,
  isActive: boolean,
  fontProvider: SkTypefaceFontProvider,
): SkParagraph {
  const cacheKey = `${lineNum}-${isActive}`;
  const existing = lineNumberCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const para = Skia.ParagraphBuilder.Make(
    {
      textAlign: TextAlign.Right,
      textStyle: {
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: Skia.Color(
          isActive
            ? EDITOR_THEME.lineNumberActiveColor
            : EDITOR_THEME.lineNumberColor,
        ),
      },
    },
    fontProvider,
  )
    .addText(String(lineNum))
    .build();
  para.layout(EDITOR_THEME.gutterWidth - EDITOR_THEME.gutterPaddingRight);
  
  lineNumberCache.set(cacheKey, para);
  if (lineNumberCache.size > 600) {
    const oldestKey = lineNumberCache.keys().next().value;
    if (oldestKey !== undefined) lineParagraphCache.delete(oldestKey);
  }
  return para;
}

// ── Main Draw Functions (Window-Local Y Coordinates) ────────────────────────

/**
 * Draw editor content (background, current line, selection, text, handles)
 * in window-local Y coordinates (relative to windowTopY) so the SkPicture height
 * stays bounded to the ~80-line window regardless of how deep the user scrolls.
 */
function drawEditorContentToCanvas(
  canvas: SkCanvas,
  state: EditorStateManager,
  resources: SkiaRendererResources,
  firstLine: number,
  lastLine: number,
  documentWidth: number,
  windowTopY: number,
  windowHeight: number,
) {
  const { fontProvider, charWidth } = resources;
  const {
    lineHeight,
    gutterWidth,
    contentPaddingLeft,
    cursorWidth,
  } = EDITOR_THEME;

  // 1. Clear only the bounded window rect
  canvas.drawRect(
    Skia.XYWHRect(0, 0, documentWidth, windowHeight),
    PAINTS.background,
  );

  // 2. Query syntax tokens for the windowed line range
  const syntaxTokens = state.engine.getSyntaxTokens(firstLine, lastLine);
  const tokensByLine: Record<number, SyntaxToken[]> = {};
  for (const token of syntaxTokens) {
    if (!tokensByLine[token.line]) tokensByLine[token.line] = [];
    tokensByLine[token.line].push(token);
  }

  // Batch-fetch all visible lines in one Nitro C++ call
  const rawLines = state.engine.getLines(firstLine, lastLine);
  const getRawLine = (lineNum: number): string => {
    const idx = lineNum - firstLine;
    return (idx >= 0 && idx < rawLines.length) ? rawLines[idx] : state.engine.getLine(lineNum);
  };

  // Seed stateManager's single-line cache with the cursor line from our batch fetch
  if (state.cursorLine >= firstLine && state.cursorLine <= lastLine) {
    state.primeCursorLineCache(state.cursorLine, getRawLine(state.cursorLine));
  }

  // 3. Current line highlight
  if (state.cursorLine >= firstLine && state.cursorLine <= lastLine) {
    const cursorLineLocalY = state.getLineY(state.cursorLine) - windowTopY;
    canvas.drawRect(
      Skia.XYWHRect(gutterWidth, cursorLineLocalY, documentWidth, lineHeight),
      PAINTS.currentLineHighlight,
    );
  }

  // 4. Selection background
  if (
    state.selection &&
    charWidth > 0 &&
    (state.selection.startLine !== state.selection.endLine ||
      state.selection.startColumn !== state.selection.endColumn)
  ) {
    const { startLine, startColumn, endLine, endColumn } = state.selection;
    let sLine = startLine, sCol = startColumn, eLine = endLine, eCol = endColumn;

    if (sLine > eLine || (sLine === eLine && sCol > eCol)) {
      sLine = endLine;
      sCol = endColumn;
      eLine = startLine;
      eCol = startColumn;
    }

    const selFirstLine = Math.max(firstLine, sLine);
    const selLastLine = Math.min(lastLine, eLine);

    for (let lineNum = selFirstLine; lineNum <= selLastLine; lineNum++) {
      const localY = state.getLineY(lineNum) - windowTopY;
      const isFirst = lineNum === sLine;
      const isLast = lineNum === eLine;

      const rawLine = getRawLine(lineNum);
      const colStart = isFirst ? sCol : 0;
      const colEnd = isLast ? eCol : rawLine.length + 1;

      if (colEnd > colStart) {
        const visualColStart = columnToCells(rawLine, colStart);
        const visualColEnd = columnToCells(rawLine, colEnd);
        const textXStart = gutterWidth + contentPaddingLeft + visualColStart * charWidth;
        const width = (visualColEnd - visualColStart) * charWidth;

        canvas.drawRect(
          Skia.XYWHRect(textXStart, localY, width, lineHeight),
          PAINTS.selectionBg,
        );
      }
    }
  }

  // 5. Visible lines text (with horizontal virtualization for ultra-long lines)
  let maxLenGrew = false;
  const scrollX = state.scrollOffset.x;
  const approxStartCol = charWidth > 0 ? Math.max(0, Math.floor(scrollX / charWidth) - 40) : 0;

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const localY = state.getLineY(lineNum) - windowTopY;
    const textY = localY + (lineHeight - EDITOR_THEME.fontSize) / 2;

    const rawLine = getRawLine(lineNum);
    const lineText = expandTabs(rawLine);

    if (lineText.length * EMOJI_CELLS_MAX > state.maxRenderedLineLength) {
      const lineCells = lineWidthCells(lineText);
      if (lineCells > state.maxRenderedLineLength) {
        state.maxRenderedLineLength = lineCells;
        maxLenGrew = true;
      }
    }

    let lineTokens = tokensByLine[lineNum] || [];
    if (lineTokens.length > 0) {
      lineTokens = adjustTokensForTabs(rawLine, lineTokens);
    }

    let renderText = lineText;
    let safeStart = 0;
    let textX = gutterWidth + contentPaddingLeft;

    // Horizontal virtualization for long lines (> HORIZONTAL_WINDOW_CAP chars)
    if (lineText.length > HORIZONTAL_WINDOW_CAP && charWidth > 0) {
      safeStart = snapColumnInText(lineText, Math.min(approxStartCol, lineText.length));
      const safeEnd = snapColumnInText(
        lineText,
        Math.min(lineText.length, safeStart + HORIZONTAL_WINDOW_CAP),
      );
      renderText = lineText.substring(safeStart, safeEnd);
      const startCells = columnToCells(lineText, safeStart);
      textX += startCells * charWidth;
    }

    const para = getCachedLineParagraph(renderText, fontProvider, lineTokens, safeStart);
    para.paint(canvas, textX, textY);
  }
  if (maxLenGrew) state.updateMaxScrollShared();

  // 6. Stationary Zero-Width Selection Handle (Teardrop)
  const hasRangeSelection =
    state.selection &&
    (state.selection.startLine !== state.selection.endLine ||
      state.selection.startColumn !== state.selection.endColumn);
  const isZeroWidthSelection = state.selection && !hasRangeSelection;

  if (isZeroWidthSelection && charWidth > 0 && state.cursorLine >= firstLine && state.cursorLine <= lastLine) {
    const cx =
      gutterWidth +
      contentPaddingLeft +
      columnToCells(getRawLine(state.cursorLine), state.cursorColumn) * charWidth;
    const cy = state.getLineY(state.cursorLine) - windowTopY;

    canvas.drawRect(
      Skia.XYWHRect(cx, cy, cursorWidth, lineHeight),
      PAINTS.cursor,
    );

    canvas.save();
    canvas.translate(cx + cursorWidth / 2, cy + lineHeight + 15);
    canvas.drawPath(WATER_DROP_PATH, PAINTS.handle);
    canvas.restore();
  }

  // 7. Selection handles for range selection
  if (hasRangeSelection && charWidth > 0) {
    const { startLine, startColumn, endLine, endColumn } = state.selection!;
    const drawHandle = (line: number, col: number) => {
      if (line >= firstLine && line <= lastLine) {
        const rawLine = getRawLine(line);
        const visualCol = columnToCells(rawLine, col);
        const x = gutterWidth + contentPaddingLeft + visualCol * charWidth;
        const y = state.getLineY(line) - windowTopY;

        canvas.drawRect(Skia.XYWHRect(x, y, cursorWidth, lineHeight), PAINTS.handle);
        canvas.save();
        canvas.translate(x + cursorWidth / 2, y + lineHeight + 15);
        canvas.drawPath(WATER_DROP_PATH, PAINTS.handle);
        canvas.restore();
      }
    };

    drawHandle(startLine, startColumn);
    drawHandle(endLine, endColumn);
  }
}

/**
 * Draw line numbers in window-local Y coordinates into gutterPicture.
 */
function drawEditorGutterToCanvas(
  canvas: SkCanvas,
  state: EditorStateManager,
  resources: SkiaRendererResources,
  firstLine: number,
  lastLine: number,
  windowTopY: number,
) {
  const { fontProvider } = resources;
  const { lineHeight } = EDITOR_THEME;

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const localY = state.getLineY(lineNum) - windowTopY;
    const textY = localY + (lineHeight - EDITOR_THEME.fontSize) / 2;
    const lineNumPara = getCachedLineNumberParagraph(
      lineNum,
      lineNum === state.cursorLine,
      fontProvider,
    );
    lineNumPara.paint(canvas, 0, textY);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface EditorPictures {
  contentPicture: SkPicture;
  gutterPicture: SkPicture;
  windowTopY: number;
}

/**
 * Record contentPicture and gutterPicture for a windowed range of lines
 * at window-local Y coordinates (0 .. windowHeight).
 */
export function createEditorPictures(
  state: EditorStateManager,
  resources: SkiaRendererResources,
  canvasWidth: number,
  canvasHeight: number,
  firstLine: number,
  lastLine: number,
): EditorPictures {
  const windowTopY = firstLine <= 1 ? 0 : state.getLineY(firstLine);
  const windowBottomY = state.getLineY(lastLine + 2) + 32; // +32px for bottom selection teardrop handles
  const windowHeight = Math.max(canvasHeight, windowBottomY - windowTopY);
  const documentWidth = Math.max(canvasWidth, state.maxScrollX + canvasWidth + 200);

  const contentPicture = createPicture(
    (canvas) => {
      drawEditorContentToCanvas(
        canvas,
        state,
        resources,
        firstLine,
        lastLine,
        documentWidth,
        windowTopY,
        windowHeight,
      );
    },
    { width: documentWidth, height: windowHeight },
  );

  // Memoize gutterPicture whenever (firstLine, lastLine, cursorLine, windowHeight) are unchanged
  const gutterKey = `${firstLine}:${lastLine}:${state.cursorLine}:${windowHeight}`;
  if (!cachedGutterPicture || cachedGutterKey !== gutterKey) {
    cachedGutterKey = gutterKey;
    cachedGutterPicture = createPicture(
      (canvas) => {
        drawEditorGutterToCanvas(canvas, state, resources, firstLine, lastLine, windowTopY);
      },
      { width: EDITOR_THEME.gutterWidth, height: windowHeight },
    );
  }

  return { contentPicture, gutterPicture: cachedGutterPicture, windowTopY };
}

/**
 * Backward-compatible single picture creator.
 */
export function createEditorPicture(
  state: EditorStateManager,
  resources: SkiaRendererResources,
  canvasWidth: number,
  canvasHeight: number,
): SkPicture {
  const { firstLine, lastLine } = state.getVisibleRange();
  return createEditorPictures(state, resources, canvasWidth, canvasHeight, firstLine, lastLine).contentPicture;
}
