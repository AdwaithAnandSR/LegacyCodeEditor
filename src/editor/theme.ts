/**
 * Editor theme – single source of truth for all visual constants.
 *
 * Every Skia drawing call and layout calculation references this object
 * so that changing a colour or font size propagates everywhere.
 */

export const EDITOR_THEME = {
  // ── Colours ──────────────────────────────────────────────────────────────
  background: "#1E1E1E",
  gutterBackground: "#1E1E1E",
  gutterBorder: "#333333",
  lineNumberColor: "#858585",
  lineNumberActiveColor: "#C6C6C6",
  textColor: "#D4D4D4",
  cursorColor: "#AEAFAD",
  handleColor: "#569CD6",
  selectionColor: "rgba(38, 79, 120, 0.6)",
  currentLineHighlight: "rgba(255, 255, 255, 0.04)",

  // ── Syntax Colours ───────────────────────────────────────────────────────
  syntaxColors: {
    keyword: "#569CD6",
    function: "#DCDCAA",
    string: "#CE9178",
    number: "#B5CEA8",
    comment: "#6A9955",
    property: "#9CDCFE",
    variable: "#9CDCFE",
    default: "#D4D4D4",
  } as Record<string, string>,

  // ── Font ─────────────────────────────────────────────────────────────────
  fontFamily: "SpaceMono",
  fontSize: 14,
  lineHeight: 20, // px per line (fontSize + vertical padding)

  // ── Layout ───────────────────────────────────────────────────────────────
  gutterWidth: 52, // px reserved for line numbers
  gutterPaddingRight: 12,
  contentPaddingLeft: 8,
  contentPaddingTop: 8,

  // ── Cursor ───────────────────────────────────────────────────────────────
  cursorWidth: 2,
  cursorBlinkIntervalMs: 530,

  // ── Behaviors ────────────────────────────────────────────────────────────
  // Controls where the cursor locks to the screen when the keyboard is active
  // 0.5 = Dead Center (50%), 0.25 = Upper Quarter, 0.75 = Lower Quarter
  typewriterOffset: 0.5,
} as const;

export type EditorTheme = typeof EDITOR_THEME;
