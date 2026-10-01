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
  type SkTypefaceFontProvider,
  type SkParagraph,
  createPicture,
} from "@shopify/react-native-skia";
import type { EditorStateManager } from "./EditorStateManager";
import { EDITOR_THEME } from "./theme";

// ── Re-export TextAlign since it's in a sub-module ───────────────────────────
import { TextAlign } from "@shopify/react-native-skia";

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
};

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
): SkParagraph {
  if (lineParagraphCache.has(text)) {
    return lineParagraphCache.get(text)!;
  }
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
    .addText(text || " ") // empty lines still need a space for height
    .build();
  para.layout(1e6); // no wrapping
  
  lineParagraphCache.set(text, para);
  if (lineParagraphCache.size > 5000) {
    // Basic memory management: clear cache if it gets too large
    lineParagraphCache.clear();
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
  if (lineNumberCache.size > 1000) {
    lineNumberCache.clear();
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
    contentPaddingTop,
    cursorWidth,
  } = EDITOR_THEME;

  // ── 1. Clear background ────────────────────────────────────────────────
  canvas.drawPaint(PAINTS.background);

  // ── 2. Draw fixed gutter background & border ───────────────────────────
  canvas.drawRect(
    Skia.XYWHRect(0, 0, gutterWidth, canvasHeight),
    PAINTS.gutterBg,
  );
  canvas.drawLine(gutterWidth, 0, gutterWidth, canvasHeight, PAINTS.gutterBorder);

  // ── 3. Compute visible range for mathematical virtualization ───────────
  const { firstLine, lastLine } = state.getVisibleRange();
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

  // Apply Hardware Canvas Translation for vertical scrolling.
  // We do NOT translate X globally because the gutter must stay fixed on the left!
  canvas.save();
  canvas.translate(0, -state.scrollOffset.y);

  // ── 4. Draw current line highlight ─────────────────────────────────────
  const cursorLineY = state.getLineY(state.cursorLine);
  // Check against translated viewport bounds
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

  // ── 4.5 Draw selection background ──────────────────────────────────────
  if (state.selection && charWidth > 0) {
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

      const colStart = isFirst ? sCol : 0;
      let colEnd = isLast ? eCol : state.engine.getLineLength(lineNum) + 1; // +1 for newline

      if (colEnd > colStart) {
        const textXStart = gutterWidth + contentPaddingLeft + (colStart * charWidth) - state.scrollOffset.x;
        const width = (colEnd - colStart) * charWidth;

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

  // ── 5. Draw visible lines ──────────────────────────────────────────────
  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const y = state.getLineY(lineNum);
    const textY = y + (lineHeight - EDITOR_THEME.fontSize) / 2;

    // -- Line number (Draws at fixed X=0, but translated Y)
    const lineNumPara = getCachedLineNumberParagraph(
      lineNum,
      lineNum === state.cursorLine,
      fontProvider,
    );
    lineNumPara.paint(canvas, 0, textY);

    // -- Line text (Horizontal Virtualization)
    const rawLine = state.engine.getLine(lineNum);
    
    // Update dynamic horizontal scroll bounds (mutating during render is standard for loose boundary caches)
    if (rawLine.length > state.maxRenderedLineLength) {
      state.maxRenderedLineLength = rawLine.length;
    }

    // Standardize tabs to 4 spaces to guarantee mathematical monospace alignment
    const lineText = rawLine.includes('\t') ? rawLine.replace(/\t/g, "    ") : rawLine;

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
        const para = getCachedLineParagraph(slicedText, fontProvider);
        const charX = safeStart * charWidth;
        const textX = gutterWidth + contentPaddingLeft + charX - state.scrollOffset.x;
        para.paint(canvas, textX, textY);
      }
    } else if (charWidth === 0 && lineText.length > 0) {
      // Fallback if charWidth hasn't loaded
      const para = getCachedLineParagraph(lineText, fontProvider);
      const textX = gutterWidth + contentPaddingLeft - state.scrollOffset.x;
      para.paint(canvas, textX, textY);
    }
    // If charWidth > 0 but lineText.length <= firstCharIndex, the line is 
    // entirely scrolled off-screen to the left! We optimally draw nothing.
  }

  // ── 6. Draw cursor ────────────────────────────────────────────────────
  if (state.cursorVisible) {
    // getCursorX() subtracts scrollOffset.x, making it a screen coordinate.
    // getCursorY() calls getLineY(), making it an absolute document coordinate.
    // This perfectly matches our hybrid translated canvas.
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
    }
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
