# Workouts prototype

This branch contains a disposable UI prototype under **Trackers → Workouts**, not a deployed
fitness service. It is available only when both `VITE_MOCK=1` and
`VITE_WORKOUTS_PROTOTYPE=1` are set at build time and the demo represents a parent.
Normal production and demo builds do not offer it. No API routes or database migrations are added.
The workouts change is independent of SSO/OIDC and does not alter sign-in or logout.
Within this preview, **Settings → General → Features → Change → Trackers → Workouts** enables
or hides the view. It defaults on, blocks direct workout links when off, and does not erase data.
`features.trackersWorkouts` is a mock-only switch, not a new production server setting.

## Try the flow

- **Whose workouts** follows Health's independent dropdown pattern rather than changing the
  calendar's **Show only** filter. It offers the demo's grown-ups (Alex and Sam), never Family
  or a kid. It initially prefers the signed-in grown-up, then a grown-up selected in the header,
  then the first grown-up, and remembers the choice for this page's lifetime. Each person has
  separate plans, routines, in-progress sessions, history, weight units and rest-timer deadlines.
  Switching people preserves their work but does not copy it into the other person's view.
- **Plan** is a read-only overview: today's/next workout and compact day/rotation cards.
  The grid uses one full-width column on every screen size.
  Choose a card to open its **Schedule** sheet, or **Edit plan** to change the full week/rotation.
  Changes stay in the sheet until **Save**; **Cancel** leaves the plan untouched. Closing a dirty
  sheet asks before discarding. Editing another rotation slot preserves the current position.
  Unassigned slots are rest days. Completing the expected workout advances a rotation;
  **Finish rest day** advances a rest slot. Repeated workouts in the sequence are supported.
- **Workouts** shows compact routine cards. Choose one for its details, then **Start workout**
  or **Edit workout**. **New workout** opens the builder sheet, where exercises, order, targets
  and rest can be edited. Save/Cancel stay in the sheet footer; closing a dirty builder asks
  before discarding. **Workout settings** changes the person's default weight unit.
- **Exercises** searches seven offline sample exercises by name/muscle and filters equipment.
  **Use exercise** asks you to choose an existing workout or **New workout**, then **Continue**
  opens the builder with that exercise appended. Existing names, notes and exercise order stay
  intact. Nothing changes until **Save workout**; **Cancel** leaves the saved workout untouched,
  and closing a changed draft asks before discarding. Workouts at the 20-exercise limit cannot
  receive another exercise. Inside an open builder, **Add exercise → Use exercise** adds directly
  to that draft instead of asking for another destination.
- **Start workout** opens a sheet to choose **Kilograms (kg)** or **Pounds (lbs)**, then snapshots
  the routine. The choice becomes that person's default. Cancel leaves both the preference and
  session unchanged. Older workouts keep their original units; weights are not silently converted.
- **Record set** reads the current form inputs, including decimal weights, and shows the saved
  repetitions/duration and weight explicitly. Enter also records a set. Editing and re-recording
  replaces that set, rather than double-counting it or dropping another set's weight. The recorded
  volume sums weight × repetitions for completed rep-based sets, not timed or unfinished sets.
  Use the deadline-based rest timer or finish a partial workout after confirming. A repeat can
  prefill weights from the last matching routine/session in the same unit. Template edits never
  rewrite session history.
- **History** shows only finished demo sessions and can repeat their saved workout.

The layout uses Kinwall's theme tokens, buttons, segmented controls and sheets, including
light/dark mode. The Plan workflow takes inspiration from
[openGym](https://github.com/DuarteSantos8/openGym); no openGym code, branding, images or
Gym Visual animations are copied.

## Run locally

Use Node 24, and install each worktree's own dependencies rather than sharing `node_modules`:

```bash
cd web
npm ci
npm run build:workouts
npm run preview:workouts
```

Open `http://localhost:5174/#/trackers/workouts`. The preview binds only to `127.0.0.1`, fails
if the port is occupied, and disables all Vite API proxies. A remote browser needs an SSH
forward to that loopback port. No firewall rule or live application configuration is changed.

On the current test host, the agent starts the transient user unit
`kinwall-workouts-preview.service`. It is not enabled at boot:

```bash
systemctl --user status kinwall-workouts-preview.service
systemctl --user stop kinwall-workouts-preview.service
```

## Data and limits

**Use demo values only.** Routine/session/plan state is held in page-lifetime memory, not in
localStorage, IndexedDB, a server database or a third-party API. Navigating to Settings or
turning Workouts off and back on preserves each person's routines, history, rotation position
and in-progress session. This separation is for testing the UI with fictitious profiles, not
server-enforced user authorization. Refreshing resets all workout data and the mock feature switch.
The enclosing Kinwall demo can still remember ordinary visual preferences; this is why
its distinct loopback origin must not be replaced with a subpath of a real household's origin.
Do not enter actual health information into this unencrypted throwaway prototype.

The source sample is text-only [Free Exercise DB](https://github.com/yuhonas/free-exercise-db),
revision `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`. Only `id`, `name`, `equipment`,
`primaryMuscles` and `instructions` from seven entries are retained in
`web/src/workout-exercises.json`. The upstream Unlicense is retained beside it as
`web/src/workout-exercises.LICENSE`. No images or animations are bundled or hotlinked.
The example plans demonstrate the UI; they are not personalized exercise advice.

Persistent private/encrypted per-member storage, server-enforced permissions, real schedule
integration, supersets, programs spanning multiple weeks, exercise-media licensing and broader
catalog import are future work, not features claimed by this prototype.

## Checks

Run `scripts/check.sh` from the worktree root. `web/test/workouts.test.ts` covers preview access,
workout/plan validation, immutable session snapshots, set recording, fixed weeks, rotation/rest
slots, immutable schedule drafts and deadline-based timers. Browser acceptance covers phone,
landscape, tablet and wall sizes in light/dark; a single-column, full-width plan grid;
read-only overviews; schedule/plan/workout/settings
sheets; Save/Cancel and dirty-sheet dismissal; recording/finishing a workout; preserving rotation
position when changing another slot; and no API requests, including when searching Settings.
Feature toggle off/on, data retention across navigation, and navigation when all other trackers
are disabled also pass. Per-person tests verify independent schedules, custom routines, history,
units and in-progress sessions across switches between Alex and Sam. Reset on reload is checked.
Weight-specific tests cover kg/lbs selection, decimal values, immediate clicks and Enter,
recorded summaries/volume, editing sets, form values submitted without a React change event,
and history preserving its units after changing preferences. Exercise-choice checks cover
existing/new destinations, saved routines remaining unchanged on Cancel, dirty-draft dismissal,
per-person isolation and direct additions inside an open builder. Never use live household data.
