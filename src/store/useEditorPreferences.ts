import { create } from "zustand";

interface EditorPreferencesState {
  directionalLockEnabled: boolean;
  setDirectionalLockEnabled: (enabled: boolean) => void;
}

export const useEditorPreferences = create<EditorPreferencesState>((set) => ({
  directionalLockEnabled: true, // Default to true as requested
  setDirectionalLockEnabled: (enabled: boolean) =>
    set({ directionalLockEnabled: enabled }),
}));
