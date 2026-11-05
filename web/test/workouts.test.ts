import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendWorkoutExercise, recordedVolume, createWorkoutMemoryStore, createWorkoutMemoryCell, assignPlanSlot, validatePlan, advancePlan, nextPlannedWorkout, beginWorkout, finishWorkout, logSet, restRemaining, validateWorkout, workoutPreviewAllowed, type Workout, type WorkoutPlan } from '../src/workouts.ts'

const routine = (): Workout => ({ id: 'a', name: 'Full-body A', notes: '', exercises: [{ exerciseId: 'Pushups', sets: 2, target: 10, mode: 'reps', restSeconds: 60 }] })

test('the workout preview requires demo mode, the explicit build flag and parent access', () => {
  assert.equal(workoutPreviewAllowed(true, '1', true), true)
  assert.equal(workoutPreviewAllowed(false, '1', true), false)
  assert.equal(workoutPreviewAllowed(true, undefined, true), false)
  assert.equal(workoutPreviewAllowed(true, '1', false), false)
  assert.equal(workoutPreviewAllowed(true, '1', true, false), false)
  assert.equal(workoutPreviewAllowed(true, '1', true, true), true)
})

test('demo memory retains data across subscribers without browser storage', () => {
  const cell = createWorkoutMemoryCell(() => ({ name: 'Example plan', sessions: 0 }))
  let changes = 0
  const unsubscribe = cell.subscribe(() => changes++)
  cell.set(previous => ({ ...previous, sessions: previous.sessions + 1 }))
  assert.equal(changes, 1)
  unsubscribe()
  cell.set(previous => ({ ...previous, sessions: previous.sessions + 1 }))
  assert.deepEqual(cell.get(), { name: 'Example plan', sessions: 2 })
  assert.equal(changes, 1)
  assert.deepEqual(createWorkoutMemoryCell(() => ({ sessions: 0 })).get(), { sessions: 0 })
})

test('workout plans, history, sessions and preferences are isolated by member', () => {
  const store = createWorkoutMemoryStore()
  for (const key of ['plan', 'routines', 'history', 'session', 'unit', 'rest']) {
    const alex = store.cell('alex', key, () => ({ value: 'initial' }))
    const sam = store.cell('sam', key, () => ({ value: 'initial' }))
    alex.set({ value: 'Alex-only change' })
    assert.deepEqual(sam.get(), { value: 'initial' })
    assert.equal(store.cell('alex', key, () => ({ value: 'must not reset' })), alex)
    assert.deepEqual(alex.get(), { value: 'Alex-only change' })
  }
  assert.notEqual(store.cell('a:b', 'c', () => 0), store.cell('a', 'b:c', () => 0))
})

test('a complete workout needs a name, known exercises and bounded targets', () => {
  const known = new Set(['Pushups'])
  assert.equal(validateWorkout(routine(), known), null)
  assert.equal(validateWorkout({ ...routine(), name: ' ' }, known), 'name')
  assert.equal(validateWorkout({ ...routine(), exercises: [] }, known), 'exercises')
  assert.equal(validateWorkout(routine(), new Set()), 'exercise')
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 21]) {
    const w = routine(); w.exercises[0].sets = invalid
    assert.equal(validateWorkout(w, known), 'targets')
  }
  const timed = routine(); timed.exercises[0] = { ...timed.exercises[0], mode: 'seconds', target: 30 }
  assert.equal(validateWorkout(timed, known), null)
})

test('adding an exercise drafts the existing workout without changing its identity or source', () => {
  const original = { ...routine(), notes: 'Keep this note' }
  const addition = { exerciseId: 'Plank', sets: 3, target: 30, mode: 'seconds' as const, restSeconds: 60 }
  const draft = appendWorkoutExercise(original, addition)
  assert.equal(draft.id, original.id)
  assert.equal(draft.name, original.name)
  assert.equal(draft.notes, original.notes)
  assert.deepEqual(draft.exercises, [...original.exercises, addition])
  draft.exercises[0].target = 99
  draft.exercises[1].target = 45
  assert.equal(original.exercises.length, 1)
  assert.equal(original.exercises[0].target, 10)
  assert.equal(addition.target, 30)
})

test('adding an exercise to a new workout leaves its name for the builder', () => {
  const blank: Workout = { id: 'new-workout', name: '', notes: '', exercises: [] }
  const draft = appendWorkoutExercise(blank, routine().exercises[0])
  assert.equal(draft.id, 'new-workout')
  assert.equal(draft.name, '')
  assert.equal(draft.exercises.length, 1)
  assert.equal(blank.exercises.length, 0)
  assert.equal(validateWorkout(draft, new Set(['Pushups'])), 'name')
})

test('adding an exercise respects the twenty-exercise limit without changing the workout', () => {
  const original = routine()
  original.exercises = Array.from({ length: 19 }, () => ({ ...original.exercises[0] }))
  const full = appendWorkoutExercise(original, original.exercises[0])
  assert.equal(full.exercises.length, 20)
  assert.equal(original.exercises.length, 19)
  assert.throws(() => appendWorkoutExercise(full, original.exercises[0]), /WORKOUT_FULL/)
  assert.equal(full.exercises.length, 20)
})

test('sessions snapshot templates; editing a routine never rewrites a workout in progress', () => {
  const w = routine(); const session = beginWorkout(w, '2026-01-01T12:00:00Z', 'session-1')
  w.name = 'Changed'; w.exercises[0].target = 99
  assert.equal(session.workout.name, 'Full-body A')
  assert.equal(session.workout.exercises[0].target, 10)
  assert.equal(session.sets.length, 2)
})

test('set logs are immutable and repeated exercise entries have independent set positions', () => {
  const w = routine(); w.exercises.push({ ...w.exercises[0] })
  const session = beginWorkout(w, '2026-01-01T12:00:00Z', 's')
  const updated = logSet(session, 2, 8, 12.5)
  assert.equal(session.sets[2].done, false)
  assert.equal(updated.sets[2].done, true)
  assert.equal(updated.sets[2].exerciseIndex, 1)
  assert.equal(updated.sets[0].done, false)
  assert.throws(() => logSet(session, -1, 8, 0))
  assert.throws(() => logSet(session, 0, NaN, 0))
  assert.throws(() => logSet(session, 0, 8, -1))
  assert.throws(() => logSet(session, 0, 0, 0))
})

test('finished sessions keep independent actuals and cannot be edited', () => {
  let session = beginWorkout(routine(), '2026-01-01T12:00:00Z', 's')
  assert.throws(() => finishWorkout(session, '2026-01-01T12:01:00Z'))
  session = logSet(session, 0, 8, 12.5)
  const finished = finishWorkout(session, '2026-01-01T12:05:00Z')
  assert.equal(finished.finishedAt, '2026-01-01T12:05:00Z')
  assert.equal(finished.sets.filter(s => s.done).length, 1)
  assert.throws(() => logSet(finished, 1, 8, 12.5))
})

for (const unit of ['kg', 'lb'] as const) {
  test(`recorded ${unit} weights survive subsequent set logs and finishing`, () => {
    let session = beginWorkout(routine(), '2026-01-01T12:00:00Z', 's', unit)
    session = logSet(session, 0, 8, 12.75)
    session = logSet(session, 1, 10, 15)
    assert.equal(session.sets[0].weight, 12.75)
    assert.equal(session.sets[1].weight, 15)
    assert.equal(recordedVolume(session), 252)
    const finished = finishWorkout(session, '2026-01-01T12:05:00Z')
    assert.equal(finished.unit, unit)
    assert.equal(finished.sets[0].weight, 12.75)
  })
}

test('recorded volume excludes unfinished sets and duration-based exercises', () => {
  const workout = routine()
  workout.exercises.push({ exerciseId: 'Plank', sets: 1, target: 30, mode: 'seconds', restSeconds: 30 })
  let session = beginWorkout(workout, '2026-01-01T12:00:00Z', 's')
  assert.equal(recordedVolume(session), 0)
  session = logSet(session, 0, 8, 12.5)
  session = logSet(session, 2, 30, 10)
  assert.equal(recordedVolume(session), 100)
})

test('fixed-week plans keep rest days and use the requested weekday', () => {
  const plan: WorkoutPlan = { mode: 'week', week: ['a', null, 'b', null, 'a', null, null], rotation: ['a', 'b', null], cursor: 0 }
  assert.equal(nextPlannedWorkout(plan, 0), 'a')
  assert.equal(nextPlannedWorkout(plan, 1), null)
  assert.equal(nextPlannedWorkout(plan, 2), 'b')
  assert.equal(advancePlan(plan), plan)
})

test('rotation plans advance by completion, preserve repeated slots and include rest days', () => {
  const plan: WorkoutPlan = { mode: 'rotation', week: [], rotation: ['a', 'b', 'a', null], cursor: 0 }
  assert.equal(nextPlannedWorkout(plan, 6), 'a')
  const second = advancePlan(plan)
  assert.equal(nextPlannedWorkout(second, 0), 'b')
  assert.equal(plan.cursor, 0)
  assert.equal(nextPlannedWorkout(advancePlan(second), 0), 'a')
  assert.equal(nextPlannedWorkout(advancePlan(advancePlan(second)), 0), null)
  assert.equal(nextPlannedWorkout(advancePlan(advancePlan(advancePlan(second))), 0), 'a')
  assert.equal(nextPlannedWorkout({ ...plan, rotation: [] }, 0), null)
})

test('schedule edits are immutable and do not silently restart an in-progress rotation', () => {
  const original: WorkoutPlan = { mode: 'rotation', week: Array(7).fill(null), rotation: ['a', 'b', null], cursor: 1 }
  const draft = assignPlanSlot(original, 0, 'b')
  assert.deepEqual(original.rotation, ['a', 'b', null])
  assert.deepEqual(draft.rotation, ['b', 'b', null])
  assert.equal(draft.cursor, 1)
  assert.throws(() => assignPlanSlot(original, -1, 'a'))
  assert.throws(() => assignPlanSlot(original, 3, 'a'))
})

test('plan drafts validate week length, rotation bounds and referenced workouts before saving', () => {
  const plan: WorkoutPlan = { mode: 'week', week: ['a', null, 'b', null, 'a', null, null], rotation: ['a', 'b', null], cursor: 0 }
  const known = new Set(['a', 'b'])
  assert.equal(validatePlan(plan, known), true)
  assert.equal(validatePlan({ ...plan, week: [] }, known), false)
  assert.equal(validatePlan({ ...plan, rotation: [] }, known), false)
  assert.equal(validatePlan({ ...plan, rotation: Array(15).fill(null) }, known), false)
  assert.equal(validatePlan({ ...plan, cursor: 3 }, known), false)
  assert.equal(validatePlan(assignPlanSlot(plan, 0, 'missing'), known), false)
})

test('rest countdown uses a deadline so background tabs do not drift or go negative', () => {
  assert.equal(restRemaining(61_000, 1_001), 60)
  assert.equal(restRemaining(61_000, 60_500), 1)
  assert.equal(restRemaining(61_000, 65_000), 0)
  assert.equal(restRemaining(null, 1_000), 0)
})
