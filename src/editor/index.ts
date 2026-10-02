/**
 * Barrel export for the editor module.
 */

export { EditorCanvas, type EditorCanvasProps } from "./EditorCanvas";
export { EditorStateManager } from "./EditorStateManager";
export { EDITOR_THEME, type EditorTheme } from "./theme";
export {
  KeyboardAccessoryBar,
  type KeyboardAccessoryBarProps,
  type AccessoryVisibilityMode,
  type AccessoryItemConfig,
  type SimpleButtonItemConfig,
  type SwipeButtonItemConfig,
  type SeparatorItemConfig,
  type AccessoryButtonActionContext,
  ACCESSORY_CATALOG,
  DEFAULT_ROW_1_ITEMS,
  DEFAULT_ROW_2_ITEMS,
  createInsertButton,
  createPairSwipeButton,
} from "./KeyboardAccessoryBar";
