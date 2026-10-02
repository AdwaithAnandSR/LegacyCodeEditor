import React, { useState, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  ScrollView,
  TouchableOpacity,
  Text,
  Platform,
  UIManager,
  LayoutAnimation,
  useWindowDimensions,
} from 'react-native';
import { SwipeButton } from './SwipeButton';
import { EDITOR_THEME } from './theme';
import type { EditorStateManager } from './EditorStateManager';

export type AccessoryVisibilityMode = 'two' | 'one' | 'hidden';

export const ACCESSORY_ROW_HEIGHT = 42;
export const ACCESSORY_BUTTON_HEIGHT = 36;
export const VISIBLE_ITEMS_PER_ROW = 5;
export const HORIZONTAL_PADDING = 8;
export const ITEM_GAP = 6;

export interface AccessoryButtonActionContext {
  stateManager: EditorStateManager;
  insertText: (text: string) => void;
  insertPair: (open: string, close: string) => void;
  isShiftActive: boolean;
  setIsShiftActive: React.Dispatch<React.SetStateAction<boolean>>;
  isCtrlActive: boolean;
  setIsCtrlActive: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface SimpleButtonItemConfig {
  id: string;
  type: 'button';
  label: string;
  onPress: (ctx: AccessoryButtonActionContext) => void;
  isActive?: (ctx: AccessoryButtonActionContext) => boolean;
}

export interface SwipeButtonItemConfig {
  id: string;
  type: 'swipe';
  label: string;
  onTap: (ctx: AccessoryButtonActionContext) => void;
  options: {
    label: string;
    onSelect: (ctx: AccessoryButtonActionContext) => void;
  }[];
}

export interface SeparatorItemConfig {
  id: string;
  type: 'separator';
}

export type AccessoryItemConfig =
  | SimpleButtonItemConfig
  | SwipeButtonItemConfig
  | SeparatorItemConfig;

// ── Factories for easy customisation ──────────────────────────────────────────

export const createInsertButton = (
  id: string,
  label: string,
  textToInsert = label
): SimpleButtonItemConfig => ({
  id,
  type: 'button',
  label,
  onPress: ({ insertText }) => insertText(textToInsert),
});

export const createPairSwipeButton = (
  id: string,
  label: string,
  open: string,
  close: string,
  extraOptions?: { label: string; text?: string }[]
): SwipeButtonItemConfig => ({
  id,
  type: 'swipe',
  label,
  onTap: ({ insertPair }) => insertPair(open, close),
  options: [
    { label: open, onSelect: ({ insertText }) => insertText(open) },
    { label: close, onSelect: ({ insertText }) => insertText(close) },
    ...(extraOptions?.map((opt) => ({
      label: opt.label,
      onSelect: ({ insertText }: AccessoryButtonActionContext) =>
        insertText(opt.text ?? opt.label),
    })) ?? []),
  ],
});

// ── Catalog of Available Buttons ──────────────────────────────────────────────

export const ACCESSORY_CATALOG: Record<string, AccessoryItemConfig> = {
  // Modifier & History Controls (Row 1 priority)
  ctrl: {
    id: 'ctrl',
    type: 'button',
    label: 'Ctrl',
    onPress: ({ setIsCtrlActive }) => setIsCtrlActive((prev) => !prev),
    isActive: ({ isCtrlActive }) => isCtrlActive,
  },
  shift: {
    id: 'shift',
    type: 'button',
    label: 'Shift',
    onPress: ({ setIsShiftActive }) => setIsShiftActive((prev) => !prev),
    isActive: ({ isShiftActive }) => isShiftActive,
  },
  tab: {
    id: 'tab',
    type: 'button',
    label: 'Tab',
    onPress: ({ stateManager, isShiftActive, setIsShiftActive }) => {
      if (isShiftActive) {
        stateManager.outdent();
        setIsShiftActive(false);
      } else {
        stateManager.indent();
      }
    },
  },
  undo: {
    id: 'undo',
    type: 'button',
    label: 'Undo',
    onPress: ({ stateManager }) => stateManager.undo(),
  },
  redo: {
    id: 'redo',
    type: 'button',
    label: 'Redo',
    onPress: ({ stateManager }) => stateManager.redo(),
  },

  // Pair & Symbol Controls (Row 2 defaults)
  parentheses: createPairSwipeButton('parentheses', '()', '(', ')'),
  braces: createPairSwipeButton('braces', '{}', '{', '}'),
  brackets: createPairSwipeButton('brackets', '[]', '[', ']'),
  'double-quotes': {
    id: 'double-quotes',
    type: 'swipe',
    label: '""',
    onTap: ({ insertPair }) => insertPair('"', '"'),
    options: [{ label: '"', onSelect: ({ insertText }) => insertText('"') }],
  },
  'single-quotes': {
    id: 'single-quotes',
    type: 'swipe',
    label: "''",
    onTap: ({ insertPair }) => insertPair("'", "'"),
    options: [{ label: "'", onSelect: ({ insertText }) => insertText("'") }],
  },
  semicolon: createInsertButton('semicolon', ';'),
  equals: createInsertButton('equals', '='),
  arrow: createInsertButton('arrow', '=>'),

  // Extra ready-to-use symbols for customization
  'angle-brackets': createPairSwipeButton('angle-brackets', '<>', '<', '>'),
  backticks: {
    id: 'backticks',
    type: 'swipe',
    label: '``',
    onTap: ({ insertPair }) => insertPair('`', '`'),
    options: [{ label: '`', onSelect: ({ insertText }) => insertText('`') }],
  },
  colon: createInsertButton('colon', ':'),
  dot: createInsertButton('dot', '.'),
  comma: createInsertButton('comma', ','),
  pipe: createInsertButton('pipe', '|'),
  ampersand: createInsertButton('ampersand', '&'),
  exclamation: createInsertButton('exclamation', '!'),
  question: createInsertButton('question', '?'),
  slash: createInsertButton('slash', '/'),
  backslash: createInsertButton('backslash', '\\'),
  plus: createInsertButton('plus', '+'),
  minus: createInsertButton('minus', '-'),
  asterisk: createInsertButton('asterisk', '*'),
  underscore: createInsertButton('underscore', '_'),
  hash: createInsertButton('hash', '#'),
  dollar: createInsertButton('dollar', '$'),
  at: createInsertButton('at', '@'),
  percent: createInsertButton('percent', '%'),
  tilde: createInsertButton('tilde', '~'),
  caret: createInsertButton('caret', '^'),

  // Separators
  'sep-1': { id: 'sep-1', type: 'separator' },
  'sep-2': { id: 'sep-2', type: 'separator' },
};

// ── Default Row Configurations ────────────────────────────────────────────────

export const DEFAULT_ROW_1_ITEMS: (string | AccessoryItemConfig)[] = [
  'ctrl',
  'shift',
  'tab',
  'undo',
  'redo',
];

export const DEFAULT_ROW_2_ITEMS: (string | AccessoryItemConfig)[] = [
  'parentheses',
  'braces',
  'brackets',
  'double-quotes',
  'single-quotes',
  'semicolon',
  'equals',
  'arrow',
];

// ── Minimizing Cycle Steps ───────────────────────────────────────────────────

interface CycleStep {
  mode: AccessoryVisibilityMode;
  icon: string;
  accessibilityLabel: string;
}

const CYCLE_STEPS: CycleStep[] = [
  { mode: 'two', icon: '▼', accessibilityLabel: 'Minimize to one row' },
  { mode: 'one', icon: '▼', accessibilityLabel: 'Hide keyboard accessory bar' },
  { mode: 'hidden', icon: '▲', accessibilityLabel: 'Show one row of keyboard accessory bar' },
  { mode: 'one', icon: '▲', accessibilityLabel: 'Expand to two rows of keyboard accessory bar' },
];

export interface KeyboardAccessoryBarProps {
  stateManager: EditorStateManager;
  /** Buttons for row 1 (highest priority). IDs from catalog or custom item configs. */
  row1Items?: (string | AccessoryItemConfig)[];
  /** Buttons for row 2. IDs from catalog or custom item configs. */
  row2Items?: (string | AccessoryItemConfig)[];
  /** Additional custom button items to merge into the catalog */
  customCatalog?: Record<string, AccessoryItemConfig>;
  /** Initial visibility mode ('two' | 'one' | 'hidden'). Defaults to 'two'. */
  initialMode?: AccessoryVisibilityMode;
  /** Callback fired whenever the visibility mode changes */
  onModeChange?: (mode: AccessoryVisibilityMode) => void;
}

export function KeyboardAccessoryBar({
  stateManager,
  row1Items = DEFAULT_ROW_1_ITEMS,
  row2Items = DEFAULT_ROW_2_ITEMS,
  customCatalog,
  initialMode = 'two',
  onModeChange,
}: KeyboardAccessoryBarProps) {
  const [isShiftActive, setIsShiftActive] = useState(false);
  const [isCtrlActive, setIsCtrlActive] = useState(false);

  const { width: windowWidth } = useWindowDimensions();

  // Each row displays up to 5 items:
  // buttonWidth = Math.floor((windowWidth - totalPadding - totalGaps) / 5)
  // Even if a row has fewer items, each item keeps this exact width.
  const itemWidth = useMemo(() => {
    const totalPadding = HORIZONTAL_PADDING * 2;
    const totalGaps = ITEM_GAP * (VISIBLE_ITEMS_PER_ROW - 1);
    const availableWidth = Math.max(0, windowWidth - totalPadding - totalGaps);
    return Math.floor(availableWidth / VISIBLE_ITEMS_PER_ROW);
  }, [windowWidth]);

  // Initialize cycle index based on initialMode
  const initialIndex = useMemo(() => {
    if (initialMode === 'one') return 1;
    if (initialMode === 'hidden') return 2;
    return 0; // 'two'
  }, [initialMode]);

  const [cycleIndex, setCycleIndex] = useState(initialIndex);

  const mergedCatalog = useMemo(() => {
    return customCatalog ? { ...ACCESSORY_CATALOG, ...customCatalog } : ACCESSORY_CATALOG;
  }, [customCatalog]);

  const resolvedRow1 = useMemo(() => {
    return row1Items
      .map((item) => (typeof item === 'string' ? mergedCatalog[item] : item))
      .filter((item): item is AccessoryItemConfig => Boolean(item));
  }, [row1Items, mergedCatalog]);

  const resolvedRow2 = useMemo(() => {
    return row2Items
      .map((item) => (typeof item === 'string' ? mergedCatalog[item] : item))
      .filter((item): item is AccessoryItemConfig => Boolean(item));
  }, [row2Items, mergedCatalog]);

  const insertText = useCallback(
    (text: string) => {
      stateManager.insertAtCursor(text);
    },
    [stateManager]
  );

  const insertPair = useCallback(
    (open: string, close: string) => {
      stateManager.insertPair(open, close);
    },
    [stateManager]
  );

  const actionContext: AccessoryButtonActionContext = useMemo(
    () => ({
      stateManager,
      insertText,
      insertPair,
      isShiftActive,
      setIsShiftActive,
      isCtrlActive,
      setIsCtrlActive,
    }),
    [stateManager, insertText, insertPair, isShiftActive, isCtrlActive]
  );

  const cycleVisibility = useCallback(() => {
    const nextIndex = (cycleIndex + 1) % CYCLE_STEPS.length;
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCycleIndex(nextIndex);
    onModeChange?.(CYCLE_STEPS[nextIndex].mode);
  }, [cycleIndex, onModeChange]);

  const currentStep = CYCLE_STEPS[cycleIndex];
  const mode = currentStep.mode;

  const barHeight =
    mode === 'two' ? ACCESSORY_ROW_HEIGHT * 2 : mode === 'one' ? ACCESSORY_ROW_HEIGHT : 0;

  return (
    <>
      {/* In-flow spacer so EditorCanvas flex layout adapts and resizes properly */}
      {barHeight > 0 && <View style={{ height: barHeight }} />}

      {/* Floating overlay container to avoid hit-test clipping on iOS/Android */}
      <View
        style={[styles.floatingOverlay, { height: barHeight + 52 }]}
        pointerEvents="box-none"
      >
        {/* Rounded floating toggle button */}
        <TouchableOpacity
          style={[styles.floatingButton, { bottom: barHeight + 8 }]}
          onPress={cycleVisibility}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={currentStep.accessibilityLabel}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.floatingButtonIcon}>{currentStep.icon}</Text>
        </TouchableOpacity>

        {/* Accessory rows container */}
        {barHeight > 0 && (
          <View style={[styles.barContainer, { height: barHeight }]}>
            {/* Row 1 (High priority - top row, always visible when bar is shown) */}
            <View style={styles.rowWrapper}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                style={styles.rowScrollView}
                contentContainerStyle={styles.rowScrollContent}
              >
                {resolvedRow1.map((item) =>
                  renderAccessoryItem(item, actionContext, itemWidth)
                )}
              </ScrollView>
            </View>

            {/* Row 2 (Bottom row - shown when mode is 'two') */}
            {mode === 'two' && (
              <View style={[styles.rowWrapper, styles.row2Wrapper]}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                  style={styles.rowScrollView}
                  contentContainerStyle={styles.rowScrollContent}
                >
                  {resolvedRow2.map((item) =>
                    renderAccessoryItem(item, actionContext, itemWidth)
                  )}
                </ScrollView>
              </View>
            )}
          </View>
        )}
      </View>
    </>
  );
}

function renderAccessoryItem(
  item: AccessoryItemConfig,
  ctx: AccessoryButtonActionContext,
  itemWidth: number
) {
  if (item.type === 'separator') {
    return <View key={item.id} style={styles.separator} />;
  }

  if (item.type === 'swipe') {
    return (
      <SwipeButton
        key={item.id}
        label={item.label}
        width={itemWidth}
        onTap={() => item.onTap(ctx)}
        options={item.options.map((opt) => ({
          label: opt.label,
          onSelect: () => opt.onSelect(ctx),
        }))}
      />
    );
  }

  const active = item.isActive ? item.isActive(ctx) : false;
  return (
    <SimpleButton
      key={item.id}
      label={item.label}
      width={itemWidth}
      onPress={() => item.onPress(ctx)}
      isActive={active}
    />
  );
}

export function SimpleButton({
  label,
  onPress,
  isActive,
  width,
}: {
  label: string;
  onPress: () => void;
  isActive?: boolean;
  width?: number;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.button,
        width !== undefined && { width, minWidth: width },
        isActive && styles.buttonActive,
      ]}
      onPress={onPress}
      activeOpacity={0.65}
    >
      <Text style={[styles.label, isActive && styles.labelActive]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  floatingOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'visible',
    zIndex: 99,
  },
  floatingButton: {
    position: 'absolute',
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2D2D2D',
    borderWidth: 1,
    borderColor: '#4A4A4A',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 6,
    zIndex: 100,
  },
  floatingButtonIcon: {
    color: '#D4D4D4',
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  barContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#1E1E1E',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#383838',
    overflow: 'visible',
    zIndex: 10,
  },
  rowWrapper: {
    height: ACCESSORY_ROW_HEIGHT,
    overflow: 'visible',
    justifyContent: 'center',
  },
  row2Wrapper: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2C2C2C',
  },
  rowScrollView: {
    height: ACCESSORY_ROW_HEIGHT,
    overflow: 'visible',
  },
  rowScrollContent: {
    paddingHorizontal: HORIZONTAL_PADDING,
    alignItems: 'center',
    flexDirection: 'row',
    height: ACCESSORY_ROW_HEIGHT,
    gap: ITEM_GAP,
    overflow: 'visible',
  },
  button: {
    height: ACCESSORY_BUTTON_HEIGHT,
    paddingHorizontal: 4,
    borderRadius: 6,
    backgroundColor: '#2D2D2D',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  buttonActive: {
    backgroundColor: '#007AFF',
    borderColor: '#0056b3',
  },
  label: {
    color: '#D4D4D4',
    fontSize: 14,
    fontWeight: '500',
    fontFamily: EDITOR_THEME.fontFamily,
  },
  labelActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  separator: {
    width: 1,
    height: 22,
    backgroundColor: '#404040',
    marginHorizontal: 6,
  },
});
