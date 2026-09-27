import { NitroModules } from 'react-native-nitro-modules'
import type { EditorEngine } from './specs/EditorEngine.nitro'

export const createEditorEngine = (): EditorEngine => {
  return NitroModules.createHybridObject<EditorEngine>('EditorEngine')
}

export type { EditorEngine }
