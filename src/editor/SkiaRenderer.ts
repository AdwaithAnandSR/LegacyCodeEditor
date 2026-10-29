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
  ClipOp,
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

// ── Main Draw Function ──────────────────────────────────────────────────────

/**
 * Draw the entire editor onto the given Skia canvas.
 *
 * Called inside `createPicture()` — records draw commands into a picture
 * that the GPU replays. This function must be fast and allocation-light.
 */
function drawEditorToCanvas(
  canvas: SkCanvas,
  state: EditorStateManager,
  resources: SkiaRendererResources,
  canvasWidth: number,
  canvasHeight: number,
) {
  const { fontProvider, charWidth } = resources;
  const {
    lineHeight,
    gutterWidth,
    contentPaddingLeft,
    cursorWidth,
  } = EDITOR_THEME;

  // ── 1. Clear background ────────────────────────────────────────────────
  canvas.drawPaint(PAINTS.background);

  // ── 2. Compute visible range for mathematical virtualization ───────────
  const { firstLine, lastLine } = state.getVisibleRange();
  
  const syntaxTokens = state.engine.getSyntaxTokens(firstLine, lastLine);
    
  const tokensByLine: Record<number, SyntaxToken[]> = {};
  for (const token of syntaxTokens) {
    if (!tokensByLine[token.line]) tokensByLine[token.line] = [];
    tokensByLine[token.line].push(token);
  }

  const contentAreaWidth = canvasWidth - gutterWidth - contentPaddingLeft;

  // Calculate Horizontal Virtualization bounds
  // We overscan by 20 characters to hide any pop-in from fast scrolling
  const OVERSCAN_X = 20;
  let firstCharIndex = 0;
  let visibleCharCount = 0;
  
  if (charWidth > 0) {
    firstCharIndex = Math.max(0, Math.floor(state.scrollOffset.x / charWidth) - OVERSCAN_X);
    visibleCharCount = Math.ceil(contentAreaWidth / charWidth) + OVERSCAN_X * 2;
  }

  // ── 3. Draw content pass (clipped to content area: solves Bug 4 text over gutter) ─
  canvas.save();
  canvas.clipRect(
    Skia.XYWHRect(gutterWidth, 0, Math.max(0, canvasWidth - gutterWidth), canvasHeight),
    ClipOp.Intersect,
    false,
  );
  canvas.translate(0, -state.scrollOffset.y);

  // ── Current line highlight ─────────────────────────────────────
  const cursorLineY = state.getLineY(state.cursorLine);
  if (
    cursorLineY + lineHeight >= state.scrollOffset.y && 
    cursorLineY <= state.scrollOffset.y + canvasHeight
  ) {
    canvas.drawRect(
      Skia.XYWHRect(
        gutterWidth,
        cursorLineY,
        contentAreaWidth + contentPaddingLeft + state.scrollOffset.x,
        lineHeight,
      ),
      PAINTS.currentLineHighlight,
    );
  }

  // ── Selection background ──────────────────────────────────────
  if (state.selection && charWidth > 0 && (state.selection.startLine !== state.selection.endLine || state.selection.startColumn !== state.selection.endColumn)) {
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

      const rawLine = state.engine.getLine(lineNum);
      const colStart = isFirst ? sCol : 0;
      let colEnd = isLast ? eCol : state.engine.getLineLength(lineNum) + 1; // +1 for newline

      if (colEnd > colStart) {
        const visualColStart = columnToVisual(rawLine, colStart);
        const visualColEnd = columnToVisual(rawLine, colEnd);
        const textXStart = gutterWidth + contentPaddingLeft + (visualColStart * charWidth) - state.scrollOffset.x;
        const width = (visualColEnd - visualColStart) * charWidth;

        let drawX = textXStart;
        let drawWidth = width;
        if (drawX < gutterWidth) {
          drawWidth -= (gutterWidth - drawX);
          drawX = gutterWidth;
        }

        if (drawWidth > 0 && drawX < canvasWidth) {
          canvas.drawRect(
            Skia.XYWHRect(drawX, y, Math.min(drawWidth, canvasWidth - drawX), lineHeight),
            PAINTS.selectionBg,
          );
        }
      }
    }
  }

  // ── Visible lines text ──────────────────────────────────────────────
  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const y = state.getLineY(lineNum);
    const textY = y + (lineHeight - EDITOR_THEME.fontSize) / 2;

    const rawLine = state.engine.getLine(lineNum);
    const lineText = expandTabs(rawLine);
    
    // Update dynamic horizontal scroll bounds
    if (lineText.length > state.maxRenderedLineLength) {
      state.maxRenderedLineLength = lineText.length;
    }

    if (charWidth > 0 && lineText.length > firstCharIndex) {
      const lastCharIndex = firstCharIndex + visibleCharCount;
      
      let safeStart = firstCharIndex;
      let safeEnd = lastCharIndex;

      // Prevent slicing surrogate pairs (emojis) in half
      if (safeStart > 0 && safeStart < lineText.length) {
        const code = lineText.charCodeAt(safeStart);
        if (code >= 0xDC00 && code <= 0xDFFF) safeStart -= 1;
      }
      if (safeEnd > 0 && safeEnd < lineText.length) {
        const code = lineText.charCodeAt(safeEnd - 1);
        if (code >= 0xD800 && code <= 0xDBFF) safeEnd += 1;
      }

      const slicedText = lineText.substring(safeStart, safeEnd);
      
      if (slicedText.length > 0) {
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
        const para = getCachedLineParagraph(slicedText, fontProvider, lineTokens, safeStart);
        const charX = safeStart * charWidth;
        const textX = gutterWidth + contentPaddingLeft + charX - state.scrollOffset.x;
        para.paint(canvas, textX, textY);
      }
    } else if (charWidth === 0 && lineText.length > 0) {
      // Fallback if charWidth hasn't loaded
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
      const textX = gutterWidth + contentPaddingLeft - state.scrollOffset.x;
      para.paint(canvas, textX, textY);
    }
  }

  // ── Cursor ────────────────────────────────────────────────────
  const hasRangeSelection = state.selection && (state.selection.startLine !== state.selection.endLine || state.selection.startColumn !== state.selection.endColumn);
  const isZeroWidthSelection = state.selection && !hasRangeSelection;
  
  if ((state.cursorVisible || isZeroWidthSelection) && !hasRangeSelection) {
    const cx = state.getCursorX();
    const cy = state.getCursorY();

    if (
      cy + lineHeight >= state.scrollOffset.y && 
      cy <= state.scrollOffset.y + canvasHeight && 
      cx >= gutterWidth
    ) {
      canvas.drawRect(
        Skia.XYWHRect(cx, cy, cursorWidth, lineHeight),
        PAINTS.cursor,
      );
      
      if (state.selection) {
        canvas.save();
        canvas.translate(cx + cursorWidth / 2, cy + lineHeight + 15);
        canvas.drawPath(WATER_DROP_PATH, PAINTS.handle);
        canvas.restore();
      }
    }
  }

  // ── Selection handles ──────────────────────────────────────────
  if (state.selection && charWidth > 0 && (state.selection.startLine !== state.selection.endLine || state.selection.startColumn !== state.selection.endColumn)) {
    const startX = state.getCursorXFor(state.selection.startColumn, state.selection.startLine);
    const startY = state.getLineY(state.selection.startLine);
    const endX = state.getCursorXFor(state.selection.endColumn, state.selection.endLine);
    const endY = state.getLineY(state.selection.endLine);

    const drawHandle = (x: number, y: number) => {
        if (y + lineHeight >= state.scrollOffset.y && y <= state.scrollOffset.y + canvasHeight && x >= gutterWidth) {
            canvas.drawRect(Skia.XYWHRect(x, y, cursorWidth, lineHeight), PAINTS.handle);
            canvas.save();
            canvas.translate(x + cursorWidth / 2, y + lineHeight + 15);
            canvas.drawPath(WATER_DROP_PATH, PAINTS.handle);
            canvas.restore();
        }
    };
    drawHandle(startX, startY);
    drawHandle(endX, endY);
  }

  canvas.restore();

  // ── 4. Draw fixed gutter background, border & line numbers on top ──────────
  canvas.drawRect(
    Skia.XYWHRect(0, 0, gutterWidth, canvasHeight),
    PAINTS.gutterBg,
  );
  canvas.drawLine(gutterWidth, 0, gutterWidth, canvasHeight, PAINTS.gutterBorder);

  canvas.save();
  canvas.translate(0, -state.scrollOffset.y);
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
  canvas.restore();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create an SkPicture that contains the full editor rendering.
 *
 * This is the main entry point called by EditorCanvas on every invalidation.
 * The returned SkPicture is rendered via the `<Picture>` component.
 */
export function createEditorPicture(
  state: EditorStateManager,
  resources: SkiaRendererResources,
  canvasWidth: number,
  canvasHeight: number,
): SkPicture {
  return createPicture(
    (canvas) => {
      drawEditorToCanvas(canvas, state, resources, canvasWidth, canvasHeight);
    },
    { width: canvasWidth, height: canvasHeight },
  );
}
