import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_ROWS, featureRowsForBuild } from '../src/featureConfig.ts'

test('workouts is a Trackers feature only in the explicitly enabled prototype build', () => {
  assert.equal(featureRowsForBuild(false, '1'), FEATURE_ROWS)
  assert.equal(featureRowsForBuild(true, undefined), FEATURE_ROWS)
  const rows = featureRowsForBuild(true, '1')
  const index = rows.findIndex(row => row.key === 'trackersHealth')
  assert.equal(rows[index + 1].key, 'trackersWorkouts')
  assert.equal(rows[index + 1].group, 'Trackers')
  assert.equal(rows.filter(row => row.key === 'trackersWorkouts').length, 1)
})

test('feature settings include every household feature', () => {
  assert.deepEqual(FEATURE_ROWS.map(feature => feature.key), [
    'chores', 'lists', 'notes', 'messages', 'announcements', 'polls', 'checkIns',
    'meals', 'outings', 'trackersReading', 'trackersMemories', 'trackersHealth', 'paint', 'photos', 'contacts', 'upkeep', 'newscast',
  ])
  assert.deepEqual([...new Set(FEATURE_ROWS.map(feature => feature.section))], ['Everyday', 'Spaces'], 'two headings, each once')
})
