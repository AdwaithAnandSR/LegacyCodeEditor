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
} from "@shopify/react-native-skia";
import type { EditorStateManager } from "./EditorStateManager";
import { columnToVisual, expandTabs } from "./EditorStateManager";
import { EDITOR_THEME } from "./theme";
import type { SyntaxToken } from "editor-engine";

// ── Re-export TextAlign since it's in a sub-module ───────────────────────────
import { TextAlign } from "@shopify/react-native-skia";

function adjustTokensForTabs(rawLine: string, tokens: SyntaxToken[]): SyntaxToken[] {
  if (!rawLine.includes('\t')) return tokens;

  return tokens.map(token => ({
    ...token,
    startColumn: columnToVisual(rawLine, token.startColumn),
    endColumn: columnToVisual(rawLine, token.endColumn),
  }));
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

export function createRendererResources(
  fontProvider: SkTypefaceFontProvider,
): SkiaRendererResources {
  return {
    fontProvider,
    charWidth: measureCharWidth(fontProvider),
  };
}

// ── Paragraph Caching (Crucial for 120fps scrolling) ────────────────────────
// Skia ParagraphBuilder is fast, but doing it 40x per frame on the JS thread
// bottlenecks the gesture event queue, causing "out of control" scrolling lag.

const lineParagraphCache = new Map<string, SkParagraph>();
const lineNumberCache = new Map<string, SkParagraph>();

function getCachedLineParagraph(
  text: string,
  fontProvider: SkTypefaceFontProvider,
  tokens?: SyntaxToken[],
  safeStart: number = 0,
): SkParagraph {
  let cacheKey = text;
  if (tokens && tokens.length > 0) {
    cacheKey += "|" + tokens.map(t => `${t.startColumn}-${t.endColumn}-${t.tokenType}`).join(',');
  }

  if (lineParagraphCache.has(cacheKey)) {
    return lineParagraphCache.get(cacheKey)!;
  }

  const builder = Skia.ParagraphBuilder.Make(
    {
      textStyle: {
        fontSize: EDITOR_THEME.fontSize,
        fontFamilies: [EDITOR_THEME.fontFamily],
        color: Skia.Color(EDITOR_THEME.textColor),
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
        builder.pushStyle({ fontSize: EDITOR_THEME.fontSize, fontFamilies: [EDITOR_THEME.fontFamily], color: Skia.Color(EDITOR_THEME.syntaxColors.default) });
        builder.addText(text.substring(currentIdx, tStart));
        builder.pop();
      }
      
      const colorHex = EDITOR_THEME.syntaxColors[token.tokenType as keyof typeof EDITOR_THEME.syntaxColors] || EDITOR_THEME.syntaxColors.default;
      builder.pushStyle({ fontSize: EDITOR_THEME.fontSize, fontFamilies: [EDITOR_THEME.fontFamily], color: Skia.Color(colorHex) });
      builder.addText(text.substring(tStart, tEnd));
      builder.pop();
      
      currentIdx = tEnd;
    }
    
    if (currentIdx < text.length) {
      builder.pushStyle({ fontSize: EDITOR_THEME.fontSize, fontFamilies: [EDITOR_THEME.fontFamily], color: Skia.Color(EDITOR_THEME.syntaxColors.default) });
      builder.addText(text.substring(currentIdx));
      builder.pop();
    }
  }

  const para = builder.build();
  para.layout(1e6); // no wrapping
  
  lineParagraphCache.set(cacheKey, para);
  if (lineParagraphCache.size > 500) {
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
  if (lineNumberCache.has(cacheKey)) {
    return lineNumberCache.get(cacheKey)!;
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
  if (lineNumberCache.size > 500) {
    const oldestKey = lineNumberCache.keys().next().value;
    if (oldestKey !== undefined) lineNumberCache.delete(oldestKey);
  }
  return para;
}

// ── Main Draw Functions (Windowed Absolute Coordinates) ─────────────────────

/**
 * Draw editor content (background, current line, selection, text, handles)
 * at absolute document coordinates into contentPicture.
 */
function drawEditorContentToCanvas(
  canvas: SkCanvas,
  state: EditorStateManager,
  resources: SkiaRendererResources,
  firstLine: number,
  lastLine: number,
  documentWidth: number,
) {
  const { fontProvider, charWidth } = resources;
  const {
    lineHeight,
    gutterWidth,
    contentPaddingLeft,
    cursorWidth,
  } = EDITOR_THEME;

  // 1. Clear background
  canvas.drawPaint(PAINTS.background);

  // 2. Query syntax tokens for the windowed line range
  const syntaxTokens = state.engine.getSyntaxTokens(firstLine, lastLine);
  const tokensByLine: Record<number, SyntaxToken[]> = {};
  for (const token of syntaxTokens) {
    if (!tokensByLine[token.line]) tokensByLine[token.line] = [];
    tokensByLine[token.line].push(token);
  }

  // Batch-fetch all visible lines in one Nitro C++ call to eliminate 50-150 JSI round-trips
  const rawLines = state.engine.getLines(firstLine, lastLine);
  const getRawLine = (lineNum: number): string => {
    const idx = lineNum - firstLine;
    return (idx >= 0 && idx < rawLines.length) ? rawLines[idx] : state.engine.getLine(lineNum);
  };

  // 3. Current line highlight
  if (state.cursorLine >= firstLine && state.cursorLine <= lastLine) {
    const cursorLineY = state.getLineY(state.cursorLine);
    canvas.drawRect(
      Skia.XYWHRect(gutterWidth, cursorLineY, documentWidth, lineHeight),
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
      const y = state.getLineY(lineNum);
      const isFirst = lineNum === sLine;
      const isLast = lineNum === eLine;

      const rawLine = getRawLine(lineNum);
      const colStart = isFirst ? sCol : 0;
      const colEnd = isLast ? eCol : rawLine.length + 1;

      if (colEnd > colStart) {
        const visualColStart = columnToVisual(rawLine, colStart);
        const visualColEnd = columnToVisual(rawLine, colEnd);
        const textXStart = gutterWidth + contentPaddingLeft + visualColStart * charWidth;
        const width = (visualColEnd - visualColStart) * charWidth;

        canvas.drawRect(
          Skia.XYWHRect(textXStart, y, width, lineHeight),
          PAINTS.selectionBg,
        );
      }
    }
  }

  // 5. Visible lines text
  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const y = state.getLineY(lineNum);
    const textY = y + (lineHeight - EDITOR_THEME.fontSize) / 2;

    const rawLine = getRawLine(lineNum);
    const lineText = expandTabs(rawLine);

    if (lineText.length > state.maxRenderedLineLength) {
      state.maxRenderedLineLength = lineText.length;
    }

    let lineTokens = tokensByLine[lineNum] || [];
    if (lineTokens.length > 0) {
      lineTokens = adjustTokensForTabs(rawLine, lineTokens);
      lineTokens.sort((a, b) => a.startColumn - b.startColumn || (b.endColumn - a.endColumn));
      const filtered = [];
      let lastEnd = -1;
      for (const t of lineTokens) {
        if (t.startColumn >= lastEnd) {
          filtered.push(t);
          lastEnd = t.endColumn;
        }
      }
      lineTokens = filtered;
    }

    const para = getCachedLineParagraph(lineText, fontProvider, lineTokens, 0);
    const textX = gutterWidth + contentPaddingLeft;
    para.paint(canvas, textX, textY);
  }

  // 6. Stationary Zero-Width Selection Handle (Teardrop)
  const hasRangeSelection =
    state.selection &&
    (state.selection.startLine !== state.selection.endLine ||
      state.selection.startColumn !== state.selection.endColumn);
  const isZeroWidthSelection = state.selection && !hasRangeSelection;

  if (isZeroWidthSelection && state.cursorLine >= firstLine && state.cursorLine <= lastLine) {
    const cx = state.getCursorDocPosition().docX;
    const cy = state.getLineY(state.cursorLine);

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
        const visualCol = columnToVisual(rawLine, col);
        const x = gutterWidth + contentPaddingLeft + visualCol * charWidth;
        const y = state.getLineY(line);

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
 * Draw line numbers in document coordinates into gutterPicture.
 */
function drawEditorGutterToCanvas(
  canvas: SkCanvas,
  state: EditorStateManager,
  resources: SkiaRendererResources,
  firstLine: number,
  lastLine: number,
) {
  const { fontProvider } = resources;
  const { lineHeight } = EDITOR_THEME;

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const y = state.getLineY(lineNum);
    const textY = y + (lineHeight - EDITOR_THEME.fontSize) / 2;
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
}

/**
 * Record contentPicture and gutterPicture for a windowed range of lines
 * at absolute document coordinates.
 */
export function createEditorPictures(
  state: EditorStateManager,
  resources: SkiaRendererResources,
  canvasWidth: number,
  canvasHeight: number,
  firstLine: number,
  lastLine: number,
): EditorPictures {
  const documentWidth = Math.max(canvasWidth, state.maxScrollX + canvasWidth + 200);
  const documentHeight = Math.max(canvasHeight, state.getLineY(lastLine + 2));

  const contentPicture = createPicture(
    (canvas) => {
      drawEditorContentToCanvas(canvas, state, resources, firstLine, lastLine, documentWidth);
    },
    { width: documentWidth, height: documentHeight },
  );

  const gutterPicture = createPicture(
    (canvas) => {
      drawEditorGutterToCanvas(canvas, state, resources, firstLine, lastLine);
    },
    { width: EDITOR_THEME.gutterWidth, height: documentHeight },
  );

  return { contentPicture, gutterPicture };
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
