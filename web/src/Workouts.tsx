import { useEffect, useState } from 'react'
import { Segmented } from './a11y.tsx'
import { formatDate, intlLocale, t, tn } from './i18n.ts'
import { useDialog } from './dialog.tsx'
import { useApp } from './AppContext.tsx'
import Sheet from './Sheet.tsx'
import WorkoutPlanView from './WorkoutPlan.tsx'
import { useWorkoutDemoState } from './workoutDemoState.ts'
import { ChevronRight } from './icons.tsx'
import { advancePlan, nextPlannedWorkout, beginWorkout, finishWorkout, logSet, recordedVolume, restRemaining, validateWorkout, type Exercise, type Prescription, type Workout, type WorkoutSession, type WorkoutPlan } from './workouts.ts'
import exerciseData from './workout-exercises.json?raw'
import './workouts.css'

const exercises = JSON.parse(exerciseData) as Exercise[]
const known = new Set(exercises.map(e => e.id))
const exercise = (id: string) => exercises.find(e => e.id === id)!
const prescription = (exerciseId: string, target = 10, mode: Prescription['mode'] = 'reps'): Prescription => ({ exerciseId, sets: 3, target, mode, restSeconds: 60 })

const weightUnitText = (unit: WorkoutSession['unit']) => unit === 'kg' ? t('kg') : t('lbs')
type View = 'plan' | 'workouts' | 'library' | 'history'
export default function Workouts() {
  const { members, meMemberId, selectedMemberId } = useApp()
  const adults = members.filter(member => member.grownUp)
  const [selected, setSelected] = useWorkoutDemoState('selected-member', () =>
    adults.find(member => member.id === meMemberId)?.id
    ?? adults.find(member => member.id === selectedMemberId)?.id
    ?? adults[0]?.id ?? '')
  const person = adults.find(member => member.id === selected) ?? adults[0]
  if (!person) return <p className="state-card">{t('Add a grown-up in Family settings to try the workout preview.')}</p>
  return <div className="workout-scope">
    <label className="field workout-person" htmlFor="workout-member">{t('Whose workouts')}<select id="workout-member" aria-label={t('Whose workouts')} value={person.id} onChange={event => setSelected(event.target.value)}>{adults.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
    <WorkoutWorkspace key={person.id} memberId={person.id} memberName={person.name} />
  </div>
}

function WorkoutWorkspace({ memberId, memberName }: { memberId: string; memberName: string }) {
  const dialog = useDialog()
  const [view, setView] = useState<View>('plan')
  const [plan, setPlan] = useWorkoutDemoState<WorkoutPlan>('plan', { mode: 'week', week: ['demo-a', null, 'demo-b', null, 'demo-a', null, null], rotation: ['demo-a', 'demo-b', null], cursor: 0 }, memberId)
  const [routines, setRoutines] = useWorkoutDemoState<Workout[]>('routines', () => [
    { id: 'demo-a', name: t('Full-body A'), notes: t('Example routine: choose weights and targets that suit you.'), exercises: [prescription('Bodyweight_Squat'), prescription('Dumbbell_Bench_Press'), prescription('One-Arm_Dumbbell_Row'), prescription('Plank', 30, 'seconds')] },
    { id: 'demo-b', name: t('Full-body B'), notes: t('Another example to try the workout builder.'), exercises: [prescription('Dumbbell_Lunges'), prescription('Dumbbell_Shoulder_Press'), prescription('Pushups')] },
  ], memberId)
  const [editing, setEditing] = useState<Workout | null>(null)
  const [starting, setStarting] = useState<Workout | null>(null)
  const [details, setDetails] = useState<Workout | null>(null)
  const [panel, setPanel] = useState<'about' | 'preferences' | null>(null)
  const [session, setSession] = useWorkoutDemoState<WorkoutSession | null>('session', null, memberId)
  const [history, setHistory] = useWorkoutDemoState<WorkoutSession[]>('history', [], memberId)
  const [unit, setUnit] = useWorkoutDemoState<'kg' | 'lb'>('unit', 'kg', memberId)
  const [deadline, setDeadline] = useWorkoutDemoState<number | null>('rest', null, memberId)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState('')
  useEffect(() => {
    if (deadline === null) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [deadline])
  useEffect(() => {
    if (!session) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [session])
  const remaining = restRemaining(deadline, now)
  const start = (workout: Workout) => {
    if (session) { setError(t('Finish or discard the current workout first.')); return }
    setStarting(structuredClone(workout))
  }
  const begin = (workout: Workout, selectedUnit: WorkoutSession['unit']) => {
    setUnit(selectedUnit)
    const started = beginWorkout(workout, new Date().toISOString(), crypto.randomUUID(), selectedUnit)
    const previous = history.find(h => h.workout.id === workout.id && h.unit === selectedUnit)
    setSession({ ...started, sets: started.sets.map((row, index) => {
      const old = previous?.sets[index]
      return old?.done && previous?.workout.exercises[old.exerciseIndex].exerciseId === workout.exercises[row.exerciseIndex].exerciseId ? { ...row, weight: old.weight } : row
    }) })
    setStarting(null); setError(''); setView('workouts'); setDeadline(null)
  }
  const handleRecord = (index: number, actual: number, weight: number) => {
    if (!session) return
    try {
      setSession(current => current ? logSet(current, index, actual, weight) : current); setError('')
      const seconds = session.workout.exercises[session.sets[index].exerciseIndex].restSeconds
      // oxlint-disable-next-line react/purity -- This runs only from the Record set click handler.
      const now = Date.now(); setNow(now); setDeadline(seconds ? now + seconds * 1000 : null)
    } catch { setError(t('Enter a positive whole number for the target and a valid nonnegative weight.')) }
  }
  const finish = async () => {
    if (!session) return
    if (session.sets.some(s => !s.done) && !await dialog.confirm({ title: t('Finish this workout?'), body: t('Some sets are unfinished. Save the sets you completed?'), confirmLabel: t('Save workout') })) return
    setHistory(previous => [finishWorkout(session, new Date().toISOString()), ...previous])
    if (plan.mode === 'rotation' && nextPlannedWorkout(plan, 0) === session.workout.id) setPlan(advancePlan(plan))
    setSession(null); setDeadline(null); setView('history'); setError('')
  }
  const discard = async () => {
    if (!await dialog.confirm({ title: t('Discard this workout?'), body: t('The sets recorded in this demo session will be lost.'), confirmLabel: t('Discard'), danger: true })) return
    setSession(null); setDeadline(null); setError('')
  }
  return <div className="workouts-preview">
    <aside className="workout-notice workout-heading" role="note"><strong>{t('Preview — resets on refresh')}</strong><button className="link-btn" onClick={() => setPanel('about')}>{t('About preview')}</button></aside>
    <Segmented<View> label={t('Workouts')} value={view} onChange={setView} options={[
      { key: 'plan', label: t('Plan') }, { key: 'workouts', label: t('Workouts') }, { key: 'library', label: t('Exercises') }, { key: 'history', label: t('History') },
    ]} />
    {error && <p role="alert">{error}</p>}
    {session && view !== 'workouts' && <div className="workout-resume" role="status"><strong>{t('In progress: {name}', { name: session.workout.name })}</strong><button className="btn btn-secondary" onClick={() => setView('workouts')}>{t('Resume workout')}</button></div>}
    {view === 'plan' && <WorkoutPlanView plan={plan} routines={routines} onChange={setPlan} onStart={start} busy={!!session} />}
    {view === 'workouts' && <>
      {session ? <section className="workout-card" aria-label={t('Workout in progress')}>
        <div className="workout-heading"><div><h2>{session.workout.name}</h2><p>{tn(session.sets.filter(s => s.done).length, '{n} set recorded', '{n} sets recorded')}</p></div><span className="chip-static">{session.unit === 'kg' ? t('Kilograms (kg)') : t('Pounds (lbs)')}</span></div>
        {session.workout.exercises.some(item => item.mode === 'reps') && <p className="workout-source">{t('Recorded volume (weight × reps): {value} {unit}', { value: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2 }).format(recordedVolume(session)), unit: weightUnitText(session.unit) })}</p>}
        {deadline !== null && <div className="workout-rest"><span role="timer" aria-live="off">{remaining ? t('Rest: {seconds} seconds', { seconds: remaining }) : t('Rest complete')}</span><button className="btn btn-secondary" onClick={() => setDeadline(null)}>{t('Dismiss timer')}</button></div>}
        {session.workout.exercises.map((item, exerciseIndex) => <section className="workout-exercise" key={exerciseIndex}>
          <h3>{exercise(item.exerciseId).name}</h3>
          <details><summary>{t('Exercise instructions')}</summary><ol>{exercise(item.exerciseId).instructions.map((text, i) => <li key={i}>{text}</li>)}</ol></details>
          {session.sets.map((row, index) => row.exerciseIndex === exerciseIndex && <SetRow key={`${session.id}:${index}:${row.done}`} row={row} mode={item.mode} unit={session.unit} onSave={(actual, weight) => handleRecord(index, actual, weight)} onEdit={() => setSession(current => current ? { ...current, sets: current.sets.map((s, i) => i === index ? { ...s, done: false } : s) } : current)} />)}
        </section>)}
        <button className="btn btn-primary" disabled={!session.sets.some(s => s.done)} onClick={finish}>{t('Finish workout')}</button>
        <div className="sheet-danger-zone"><button className="link-btn" onClick={discard}>{t('Discard workout')}</button></div>
      </section> : <>
        <div className="workout-heading"><h2>{t('My workouts')}</h2><button className="btn btn-primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', notes: '', exercises: [] })}>{t('New workout')}</button></div>
        <div className="workout-grid">{routines.map(workout => <button type="button" key={workout.id} className="workout-card workout-routine-pick" aria-label={t('View workout {name}', { name: workout.name })} onClick={() => setDetails(structuredClone(workout))}>
          <span className="workout-heading"><strong className="workout-slot-title">{workout.name}</strong><ChevronRight width={20} height={20} aria-hidden="true" /></span>
          <span className="workout-source">{tn(workout.exercises.length, '{n} exercise', '{n} exercises')}</span>
          <span className="workout-routine-preview">{workout.exercises.map(item => exercise(item.exerciseId).name).join(' · ')}</span>
        </button>)}</div>
        <button className="link-btn" onClick={() => setPanel('preferences')}>{t('Workout settings')}</button>
      </>}
    </>}
    {view === 'library' && <ExercisePicker onPick={item => setEditing({ id: crypto.randomUUID(), name: '', notes: '', exercises: [prescription(item.id)] })} />}
    {view === 'history' && <section>
      <h2>{t('Workout history')}</h2>
      {!history.length && <p className="state-card">{t('Finish a demo workout to see it here. Changes to a template will not rewrite past sessions.')}</p>}
      {history.map(item => <article className="workout-card" key={item.id}>
        <h3>{item.workout.name}</h3><p>{formatDate(new Date(item.finishedAt!), { dateStyle: 'medium', timeStyle: 'short' })}</p>
        {item.workout.exercises.map((plan, index) => <div key={index}><h4>{exercise(plan.exerciseId).name}</h4><ul>{item.sets.filter(s => s.exerciseIndex === index && s.done).map(s => <li key={s.setIndex}>{t('Set {number}: {actual} {unit}, {weight} {weightUnit}', { number: s.setIndex + 1, actual: s.actual, unit: plan.mode === 'seconds' ? t('seconds') : t('reps'), weight: s.weight, weightUnit: weightUnitText(item.unit) })}</li>)}</ul></div>)}
        <button className="btn btn-secondary" disabled={!!session} onClick={() => start(item.workout)}>{t('Repeat workout')}</button>
      </article>)}
    </section>}
    {starting && <StartWorkout workout={starting} initial={unit} onClose={() => setStarting(null)} onStart={selectedUnit => begin(starting, selectedUnit)} />}
    {editing && <WorkoutEditor initial={editing} onClose={() => setEditing(null)} onSave={workout => { setRoutines(old => old.some(w => w.id === workout.id) ? old.map(w => w.id === workout.id ? workout : w) : [...old, workout]); setEditing(null); setView('workouts') }} />}
    {details && <Sheet title={details.name} onClose={() => setDetails(null)} actions={<><button className="btn btn-secondary" onClick={() => { setEditing(structuredClone(details)); setDetails(null) }}>{t('Edit workout')}</button><button className="btn btn-primary" disabled={!!session} onClick={() => { start(details); setDetails(null) }}>{t('Start workout')}</button></>}>
      <p>{details.notes}</p><ol className="workout-detail-list">{details.exercises.map((item, index) => <li key={index}><strong>{exercise(item.exerciseId).name}</strong><span>{t('{sets} sets × {target} {unit}', { sets: item.sets, target: item.target, unit: item.mode === 'seconds' ? t('seconds') : t('reps') })}</span><span className="workout-source">{t('Rest: {seconds} seconds', { seconds: item.restSeconds })}</span></li>)}</ol>
    </Sheet>}
    {panel === 'preferences' && <WorkoutPreferences initial={unit} onClose={() => setPanel(null)} onSave={value => { setUnit(value); setPanel(null) }} />}
    {panel === 'about' && <Sheet title={t('Workout prototype — demo data only')} onClose={() => setPanel(null)}>
      <p>{t('Try this as {name}. Each person has separate workout data, kept in memory while you browse or hide the feature. Refreshing resets it; nothing is saved to your household or browser storage.', { name: memberName })}</p><p>{t('Example routines are for trying the app, not personalized training advice.')}</p><p>{t('Exercise text: Free Exercise DB. Seven offline examples; images and the full catalog are not included.')}</p>
    </Sheet>}
  </div>
}

function WeightUnitField({ unit, onChange }: { unit: WorkoutSession['unit']; onChange: (unit: WorkoutSession['unit']) => void }) {
  return <label className="field">{t('Weight unit')}<select aria-label={t('Weight unit')} value={unit} onChange={e => onChange(e.target.value as WorkoutSession['unit'])}><option value="kg">{t('Kilograms (kg)')}</option><option value="lb">{t('Pounds (lbs)')}</option></select></label>
}

function StartWorkout({ workout, initial, onClose, onStart }: { workout: Workout; initial: WorkoutSession['unit']; onClose: () => void; onStart: (unit: WorkoutSession['unit']) => void }) {
  const [unit, setUnit] = useState(initial)
  return <Sheet title={t('Start workout')} onClose={onClose} dirty={unit !== initial} actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" onClick={() => onStart(unit)}>{t('Start workout')}</button></>}>
    <h3>{workout.name}</h3><WeightUnitField unit={unit} onChange={setUnit} />
    <p>{t('Choose the units for this workout. Your choice is remembered for your next session; older workouts keep their original units.')}</p>
  </Sheet>
}

function WorkoutPreferences({ initial, onClose, onSave }: { initial: 'kg' | 'lb'; onClose: () => void; onSave: (value: 'kg' | 'lb') => void }) {
  const [unit, setUnit] = useState(initial)
  return <Sheet title={t('Workout settings')} onClose={onClose} dirty={unit !== initial} actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" onClick={() => onSave(unit)}>{t('Save settings')}</button></>}>
    <WeightUnitField unit={unit} onChange={setUnit} />
  </Sheet>
}

function SetRow({ row, mode, unit, onSave, onEdit }: { row: WorkoutSession['sets'][number]; mode: Prescription['mode']; unit: WorkoutSession['unit']; onSave: (actual: number, weight: number) => void; onEdit: () => void }) {
  const [actual, setActual] = useState(String(row.actual))
  const [weight, setWeight] = useState(String(row.weight))
  if (row.done) return <div className="workout-set workout-set-recorded">
    <strong>{t('Set {number}', { number: row.setIndex + 1 })}</strong>
    <span role="status" className="workout-set-result">{t('Recorded: {actual} {unit} at {weight} {weightUnit}', { actual: row.actual, unit: mode === 'seconds' ? t('seconds') : t('reps'), weight: row.weight, weightUnit: weightUnitText(unit) })}</span>
    <button type="button" className="btn btn-secondary" onClick={onEdit}>{t('Edit set')}</button>
  </div>
  return <form className="workout-set" onSubmit={event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const count = String(data.get('actual') ?? '')
    const load = String(data.get('weight') ?? '')
    onSave(count.trim() ? Number(count) : NaN, load.trim() ? Number(load) : NaN)
  }}>
    <strong>{t('Set {number}', { number: row.setIndex + 1 })}</strong>
    <label>{mode === 'seconds' ? t('Seconds') : t('Reps')}<input name="actual" type="number" min="1" max={mode === 'seconds' ? 3600 : 500} step="1" required value={actual} onChange={e => setActual(e.target.value)} /></label>
    <label>{t('Weight ({unit})', { unit: weightUnitText(unit) })}<input name="weight" type="number" inputMode="decimal" min="0" max="2000" step="any" required value={weight} onChange={e => setWeight(e.target.value)} /></label>
    <button type="submit" className="btn btn-primary">{t('Record set')}</button>
  </form>
}

function ExercisePicker({ onPick }: { onPick: (exercise: Exercise) => void }) {
  const [query, setQuery] = useState('')
  const [equipment, setEquipment] = useState('all')
  const found = exercises.filter(e => `${e.name} ${e.primaryMuscles.join(' ')}`.toLowerCase().includes(query.toLowerCase()) && (equipment === 'all' || e.equipment === equipment))
  return <div>
    <div className="workout-filters"><label className="field">{t('Find an exercise')}<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Name or muscle group')} /></label>
      <label className="field">{t('Equipment')}<select value={equipment} onChange={e => setEquipment(e.target.value)}><option value="all">{t('All equipment')}</option><option value="body only">{t('Bodyweight')}</option><option value="dumbbell">{t('Dumbbells')}</option></select></label></div>
    {!found.length && <p role="status">{t('No exercises match. Try a different search or equipment filter.')}</p>}
    <div className="workout-grid">{found.map(item => <article className="workout-card" key={item.id}><h3>{item.name}</h3><p>{item.primaryMuscles.join(', ')}</p><details><summary>{t('Exercise instructions')}</summary><ol>{item.instructions.map((text, i) => <li key={i}>{text}</li>)}</ol></details><button className="btn btn-secondary" onClick={() => onPick(item)}>{t('Use exercise')}</button></article>)}</div>
  </div>
}

function WorkoutEditor({ initial, onClose, onSave }: { initial: Workout; onClose: () => void; onSave: (workout: Workout) => void }) {
  const dialog = useDialog()
  const [workout, setWorkout] = useState(() => structuredClone(initial))
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const update = (index: number, change: Partial<Prescription>) => setWorkout(w => ({ ...w, exercises: w.exercises.map((e, i) => i === index ? { ...e, ...change } : e) }))
  const move = (index: number, direction: number) => setWorkout(w => { const rows = [...w.exercises]; [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]]; return { ...w, exercises: rows } })
  const save = () => {
    if (validateWorkout(workout, known)) { setError(t('Add a name and at least one exercise. Use 1–20 sets, a positive target, and 0–600 seconds of rest.')); return }
    onSave({ ...workout, name: workout.name.trim() })
  }
  const remove = async (index: number) => {
    if (!await dialog.confirm({ title: t('Remove "{name}"?', { name: exercise(workout.exercises[index].exerciseId).name }), confirmLabel: t('Remove'), danger: true })) return
    setWorkout(w => ({ ...w, exercises: w.exercises.filter((_, i) => i !== index) }))
  }
  return <Sheet title={t('Workout builder')} onClose={onClose} dirty={JSON.stringify(workout) !== JSON.stringify(initial)} actions={picking ? <button className="btn btn-secondary" onClick={() => setPicking(false)}>{t('Back to workout')}</button> : <><button className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" onClick={save}>{t('Save workout')}</button></>}>
    {picking ? <ExercisePicker onPick={item => { setWorkout(w => ({ ...w, exercises: [...w.exercises, prescription(item.id)] })); setPicking(false) }} /> : <div className="workout-editor">
      <label className="field">{t('Workout name')}<input value={workout.name} maxLength={80} onChange={e => setWorkout(w => ({ ...w, name: e.target.value }))} /></label>
      <label className="field">{t('Workout notes')}<textarea value={workout.notes} maxLength={1000} onChange={e => setWorkout(w => ({ ...w, notes: e.target.value }))} /></label>
      {workout.exercises.map((item, index) => <section className="workout-exercise" key={index}>
        <h3>{exercise(item.exerciseId).name}</h3>
        <div className="workout-fields">
          <label>{t('Sets')}<input type="number" min="1" max="20" value={item.sets} onChange={e => update(index, { sets: Number(e.target.value) })} /></label>
          <label>{t('Target type')}<select aria-label={t('Target type')} value={item.mode} onChange={e => update(index, { mode: e.target.value as Prescription['mode'] })}><option value="reps">{t('Repetitions')}</option><option value="seconds">{t('Seconds')}</option></select></label>
          <label>{t('Target per set')}<input type="number" min="1" max={item.mode === 'seconds' ? 3600 : 500} value={item.target} onChange={e => update(index, { target: Number(e.target.value) })} /></label>
          <label>{t('Rest in seconds')}<input type="number" min="0" max="600" value={item.restSeconds} onChange={e => update(index, { restSeconds: Number(e.target.value) })} /></label>
        </div>
        <div className="workout-actions"><button className="link-btn" disabled={index === 0} onClick={() => move(index, -1)}>{t('Move up')}</button><button className="link-btn" disabled={index === workout.exercises.length - 1} onClick={() => move(index, 1)}>{t('Move down')}</button></div>
        <div className="sheet-danger-zone"><button className="link-btn" onClick={() => remove(index)}>{t('Remove exercise')}</button></div>
      </section>)}
      <button className="btn btn-secondary" disabled={workout.exercises.length >= 20} onClick={() => setPicking(true)}>{t('Add exercise')}</button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </Sheet>
}
