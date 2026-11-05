import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { createWorkoutMemoryStore } from './workouts.ts'

// Mock-only, page-lifetime memory. No localStorage, IndexedDB, credentials or server writes.
const memory = createWorkoutMemoryStore()
// Workspaces are keyed by member, so the owner stays fixed for each hook's mount.
export function useWorkoutDemoState<T>(key: string, initial: T | (() => T), memberId = 'preview'): [T, Dispatch<SetStateAction<T>>] {
  const [cell] = useState(() => memory.cell(memberId, key, () => typeof initial === 'function' ? (initial as () => T)() : initial))
  return [useSyncExternalStore(cell.subscribe, cell.get), cell.set]
}
