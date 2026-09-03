import assert from 'node:assert/strict'
import test from 'node:test'
import { beginWorkAttempt, invalidateAttempt, StaleAttemptError, updateWork } from '../src/work.js'
import { companyState } from './fixtures.js'

test('work attempt ids fence stale updates after reassignment', () => {
  const state = withImplementationWork()
  const work = state.workItems[0]!
  const first = beginWorkAttempt(state, work, 'e1')
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId: first, status: 'in_progress' })
  invalidateAttempt(work, 'e1', 'Retry with a fresh capability')
  work.reassigning = false
  const second = beginWorkAttempt(state, work, 'e1')
  assert.notEqual(first, second)
  assert.throws(() => updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId: first, status: 'failed', output: 'stale' }), StaleAttemptError)
})

test('implementation completion enforces changed-path and acceptance evidence', () => {
  const state = withImplementationWork()
  const work = state.workItems[0]!
  const attempt = beginWorkAttempt(state, work, 'e1')
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId: attempt, status: 'in_progress' })
  assert.throws(() => updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId: attempt, status: 'completed', output: 'done' }), /changed_paths/)
  const completed = updateWork(state, '/workspace', 'e1', {
    workId: work.id,
    attemptId: attempt,
    status: 'completed',
    output: 'Implemented and verified.',
    changedPaths: ['product/index.ts'],
    acceptanceResults: ['node --test: pass'],
    commandsRun: ['node --test'],
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.attemptId, undefined)
})

function withImplementationWork() {
  const state = companyState()
  state.workItems.push({
    id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Implement', objective: 'Implement bounded change',
    status: 'pending', eligibleEmployeeIds: ['e1'], dependencies: [], inScope: ['product'], outOfScope: ['product/private'],
    acceptance: ['Tests pass'], verify: ['Run tests'], deliverables: ['Code'], attempt: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  })
  state.counters.work = 1
  return state
}
