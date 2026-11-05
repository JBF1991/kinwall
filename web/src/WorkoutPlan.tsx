import { useState } from 'react'
import Sheet from './Sheet.tsx'
import { useDialog } from './dialog.tsx'
import { formatDate, t, tn } from './i18n.ts'
import { ChevronRight } from './icons.tsx'
import { advancePlan, assignPlanSlot, nextPlannedWorkout, validatePlan, type Workout, type WorkoutPlan } from './workouts.ts'

const slotLabel = (plan: WorkoutPlan, index: number) => plan.mode === 'week'
  ? formatDate(new Date(Date.UTC(2026, 0, 5 + index, 12)), { weekday: 'long', timeZone: 'UTC' })
  : t('Step {number}', { number: index + 1 })

/** Read-only plan overview. All changes are drafted in a sheet and applied only on Save. */
export default function WorkoutPlanView({ plan, routines, onChange, onStart, busy }: {
  plan: WorkoutPlan; routines: Workout[]; onChange: (p: WorkoutPlan) => void; onStart: (w: Workout) => void; busy: boolean
}) {
  const [today] = useState(() => (new Date().getDay() + 6) % 7)
  const [editing, setEditing] = useState(false)
  const [slot, setSlot] = useState<number | null>(null)
  const next = routines.find(w => w.id === nextPlannedWorkout(plan, today))
  const slots = plan.mode === 'week' ? plan.week : plan.rotation
  return <section className="workout-plan">
    <div className="workout-heading"><h2>{t('Your training plan')}</h2><button className="btn btn-secondary" disabled={busy} onClick={() => setEditing(true)}>{t('Edit plan')}</button></div>
    <section className="workout-card workout-next">
      <div><p className="workout-eyebrow">{plan.mode === 'week' ? t('Today’s workout') : t('Next in your rotation')}</p><h3>{next?.name ?? t('Rest day')}</h3>{next && <p>{tn(next.exercises.length, '{n} exercise', '{n} exercises')}</p>}</div>
      {next ? <button className="btn btn-primary" disabled={busy} onClick={() => onStart(next)}>{t('Start workout')}</button> : plan.mode === 'rotation' && <button className="btn btn-secondary" disabled={busy} onClick={() => onChange(advancePlan(plan))}>{t('Finish rest day')}</button>}
    </section>
    <div className="workout-heading"><h3>{plan.mode === 'week' ? t('Your week') : t('Your rotation')}</h3><span className="chip-static">{plan.mode === 'week' ? t('Fixed week') : t('Repeating rotation')}</span></div>
    <p className="workout-source">{t('Choose a day or step to change its workout.')}</p>
    <div className="workout-plan-grid">{slots.map((id, index) => {
      const routine = routines.find(w => w.id === id)
      const label = slotLabel(plan, index)
      const current = plan.mode === 'week' ? index === today : index === plan.cursor
      return <button type="button" className="workout-plan-day workout-plan-pick" key={index} aria-label={t('Edit schedule for {day}', { day: label })} aria-current={current ? 'step' : undefined} disabled={busy} onClick={() => setSlot(index)}>
        <span className="workout-heading"><strong>{label}</strong>{current && <span className="chip-static">{plan.mode === 'week' ? t('Today') : t('Next')}</span>}</span>
        <span className="workout-slot-title">{routine?.name ?? t('Rest day')}</span>
        <span className="workout-heading workout-source"><span>{routine ? tn(routine.exercises.length, '{n} exercise', '{n} exercises') : t('Recovery time')}</span><ChevronRight width={18} height={18} aria-hidden="true" /></span>
      </button>
    })}</div>
    {editing && <PlanEditor initial={plan} routines={routines} onClose={() => setEditing(false)} onSave={draft => { onChange(draft); setEditing(false) }} />}
    {slot !== null && <ScheduleEditor plan={plan} index={slot} routines={routines} onClose={() => setSlot(null)} onSave={id => { onChange(assignPlanSlot(plan, slot, id)); setSlot(null) }} />}
  </section>
}

function ScheduleEditor({ plan, index, routines, onClose, onSave }: {
  plan: WorkoutPlan; index: number; routines: Workout[]; onClose: () => void; onSave: (id: string | null) => void
}) {
  const original = (plan.mode === 'week' ? plan.week : plan.rotation)[index]
  const [selection, setSelection] = useState(original)
  const chosen = routines.find(w => w.id === selection)
  return <Sheet title={t('Schedule for {day}', { day: slotLabel(plan, index) })} onClose={onClose} dirty={selection !== original} actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" onClick={() => onSave(selection)}>{t('Save schedule')}</button></>}>
    <label className="field">{t('Workout')}<select aria-label={t('Workout')} value={selection ?? ''} onChange={e => setSelection(e.target.value || null)}><option value="">{t('Rest day')}</option>{routines.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    {chosen ? <div className="workout-readout"><h3>{chosen.name}</h3><p>{chosen.notes}</p><p>{tn(chosen.exercises.length, '{n} exercise', '{n} exercises')}</p></div> : <p>{t('No workout is scheduled for this slot.')}</p>}
  </Sheet>
}

function PlanEditor({ initial, routines, onClose, onSave }: { initial: WorkoutPlan; routines: Workout[]; onClose: () => void; onSave: (p: WorkoutPlan) => void }) {
  const dialog = useDialog()
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const slots = draft.mode === 'week' ? draft.week : draft.rotation
  const valid = validatePlan(draft, new Set(routines.map(w => w.id)))
  const removeLast = async () => {
    if (!await dialog.confirm({ title: t('Remove the last rotation step?'), confirmLabel: t('Remove'), danger: true })) return
    setDraft(p => ({ ...p, rotation: p.rotation.slice(0, -1), cursor: Math.min(p.cursor, p.rotation.length - 2) }))
  }
  return <Sheet title={t('Edit training plan')} onClose={onClose} dirty={JSON.stringify(draft) !== JSON.stringify(initial)} actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" disabled={!valid} onClick={() => onSave(draft)}>{t('Save plan')}</button></>}>
    <div className="workout-editor">
      <label className="field">{t('Schedule')}<select aria-label={t('Schedule')} value={draft.mode} onChange={e => setDraft(p => ({ ...p, mode: e.target.value as WorkoutPlan['mode'] }))}><option value="week">{t('Fixed week')}</option><option value="rotation">{t('Repeating rotation')}</option></select></label>
      <p>{draft.mode === 'week' ? t('Assign workouts to weekdays. Unassigned days are rest days.') : t('Follow the sequence at your own pace. Completing a workout moves the rotation forward.')}</p>
      {slots.map((id, index) => <label className="field" key={index}>{slotLabel(draft, index)}<select aria-label={t('Workout for {day}', { day: slotLabel(draft, index) })} value={id ?? ''} onChange={e => setDraft(p => assignPlanSlot(p, index, e.target.value || null))}><option value="">{t('Rest day')}</option>{routines.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>)}
      {draft.mode === 'rotation' && <><button className="btn btn-secondary" disabled={slots.length >= 14} onClick={() => setDraft(p => ({ ...p, rotation: [...p.rotation, null] }))}>{t('Add step')}</button><div className="sheet-danger-zone"><button className="link-btn" disabled={slots.length <= 1} onClick={removeLast}>{t('Remove last step')}</button></div></>}
    </div>
  </Sheet>
}
