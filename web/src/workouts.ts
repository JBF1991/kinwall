// Demo-only workout model. No storage, network, real member data or health persistence.
export type Exercise = { id: string; name: string; equipment: string | null; primaryMuscles: string[]; instructions: string[] }
export type Prescription = { exerciseId: string; sets: number; target: number; mode: 'reps' | 'seconds'; restSeconds: number }
export type Workout = { id: string; name: string; notes: string; exercises: Prescription[] }
export type LoggedSet = { exerciseIndex: number; setIndex: number; actual: number; weight: number; done: boolean }
export type WorkoutSession = { id: string; workout: Workout; startedAt: string; finishedAt: string | null; unit: 'kg' | 'lb'; sets: LoggedSet[] }

export function workoutPreviewAllowed(demo: boolean, flag: string | undefined, parent: boolean, enabled = true): boolean {
  return demo && flag === '1' && parent && enabled
}
/** One page-lifetime value. Unmounting or hiding a view never deletes its demo data. */
export function createWorkoutMemoryCell<T>(initial: () => T) {
  let value = initial()
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(update: T | ((previous: T) => T)) {
      const next = typeof update === 'function' ? (update as (previous: T) => T)(value) : update
      if (Object.is(next, value)) return
      value = next
      listeners.forEach(listener => listener())
    },
  }
}
/** Separate cells per member and domain, with no browser or server persistence. */
export function createWorkoutMemoryStore() {
  const cells = new Map<string, unknown>()
  return {
    cell<T>(memberId: string, domain: string, initial: () => T) {
      const key = JSON.stringify([memberId, domain])
      if (!cells.has(key)) cells.set(key, createWorkoutMemoryCell(initial))
      return cells.get(key) as ReturnType<typeof createWorkoutMemoryCell<T>>
    },
  }
}
const whole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max
export function validateWorkout(workout: Workout, exerciseIds: Set<string>): 'name' | 'exercises' | 'exercise' | 'targets' | null {
  if (!workout.name.trim() || workout.name.length > 80 || workout.notes.length > 1000) return 'name'
  if (!workout.exercises.length || workout.exercises.length > 20) return 'exercises'
  for (const item of workout.exercises) {
    if (!exerciseIds.has(item.exerciseId)) return 'exercise'
    if (!whole(item.sets, 1, 20) || !['reps', 'seconds'].includes(item.mode)
      || !whole(item.target, 1, item.mode === 'seconds' ? 3600 : 500) || !whole(item.restSeconds, 0, 600)) return 'targets'
  }
  return null
}
export function beginWorkout(workout: Workout, startedAt: string, id: string, unit: 'kg' | 'lb' = 'kg'): WorkoutSession {
  if (validateWorkout(workout, new Set(workout.exercises.map(e => e.exerciseId))) || !Number.isFinite(Date.parse(startedAt)) || !['kg', 'lb'].includes(unit)) throw new Error('INVALID_WORKOUT')
  return {
    id, workout: structuredClone(workout), startedAt, finishedAt: null, unit,
    sets: workout.exercises.flatMap((exercise, exerciseIndex) => Array.from({ length: exercise.sets }, (_, setIndex) => ({ exerciseIndex, setIndex, actual: exercise.target, weight: 0, done: false }))),
  }
}
export function logSet(session: WorkoutSession, index: number, actual: number, weight: number): WorkoutSession {
  const set = session.sets[index]
  if (session.finishedAt || !set || !whole(actual, 1, session.workout.exercises[set.exerciseIndex].mode === 'seconds' ? 3600 : 500)
    || !Number.isFinite(weight) || weight < 0 || weight > 2000) throw new Error('INVALID_SET')
  return { ...session, sets: session.sets.map((row, i) => i === index ? { ...row, actual, weight, done: true } : row) }
}
/** Volume is load × repetitions for recorded rep sets, never timed/unfinished sets. */
export function recordedVolume(session: WorkoutSession): number {
  return session.sets.reduce((sum, set) => sum + (set.done && session.workout.exercises[set.exerciseIndex].mode === 'reps' ? set.actual * set.weight : 0), 0)
}
export function finishWorkout(session: WorkoutSession, finishedAt: string): WorkoutSession {
  if (session.finishedAt || !session.sets.some(s => s.done) || !Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) < Date.parse(session.startedAt)) throw new Error('INVALID_FINISH')
  return { ...structuredClone(session), finishedAt }
}
export type WorkoutPlan = { mode: 'week' | 'rotation'; week: (string | null)[]; rotation: (string | null)[]; cursor: number }
export function assignPlanSlot(plan: WorkoutPlan, index: number, workoutId: string | null): WorkoutPlan {
  const key = plan.mode === 'week' ? 'week' : 'rotation'
  if (!Number.isInteger(index) || index < 0 || index >= plan[key].length) throw new Error('INVALID_PLAN_SLOT')
  return { ...plan, [key]: plan[key].map((id, i) => i === index ? workoutId : id) }
}
export function validatePlan(plan: WorkoutPlan, workoutIds: Set<string>): boolean {
  return ['week', 'rotation'].includes(plan.mode) && plan.week.length === 7
    && plan.rotation.length >= 1 && plan.rotation.length <= 14
    && whole(plan.cursor, 0, plan.rotation.length - 1)
    && [...plan.week, ...plan.rotation].every(id => id === null || workoutIds.has(id))
}
export function nextPlannedWorkout(plan: WorkoutPlan, mondayIndex: number): string | null {
  if (plan.mode === 'week') return plan.week[mondayIndex] ?? null
  return plan.rotation.length ? plan.rotation[plan.cursor % plan.rotation.length] ?? null : null
}
export function advancePlan(plan: WorkoutPlan): WorkoutPlan {
  return plan.mode === 'rotation' && plan.rotation.length ? { ...plan, cursor: (plan.cursor + 1) % plan.rotation.length } : plan
}
export function restRemaining(deadline: number | null, now: number): number {
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000))
}
