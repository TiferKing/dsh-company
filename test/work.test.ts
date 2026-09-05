import assert from 'node:assert/strict'
import test from 'node:test'
import { beginWorkAttempt, canEmployeeOwn, invalidateAttempt, isDescendantOrgUnit, selectReadyWork, StaleAttemptError, updateWork, workBlockedReasons } from '../src/work.js'
import { companyState } from './fixtures.js'


test('HR employees are hard-denied from ordinary work dispatch', () => {
  const state = companyState()
  state.employees[0]!.isHr = true
  state.workItems.push({ id: 'w1', productId: 'p1', kind: 'implementation', subject: 'S', objective: 'O', status: 'pending', dependencies: [], inScope: [], outOfScope: [], acceptance: ['a'], verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: 1, updatedAt: 1 })
  state.counters.work = 1
  const work = state.workItems[0]!
  work.status = 'pending'
  work.assigneeId = undefined
  assert.equal(canEmployeeOwn(state, work, 'e1'), false, 'HR cannot own ordinary work')
  // Even with explicit assignee_id pointing at HR, canEmployeeOwn rejects.
  work.assigneeId = 'e1'
  assert.equal(canEmployeeOwn(state, work, 'e1'), false, 'HR rejected even when directly assigned')
  work.assigneeId = undefined
  // Non-HR employee is fine.
  state.employees.push({ ...state.employees[0]!, id: 'e2', isHr: false, sessionId: 'e2-session' })
  assert.equal(canEmployeeOwn(state, work, 'e2'), true)
  // selectReadyWork for HR returns undefined.
  assert.equal(selectReadyWork(state, 'e1'), undefined)
})

test('org-unit scoped work only reaches employees in the subtree', () => {
  const state = companyState()
  state.workItems.push({ id: 'w1', productId: 'p1', kind: 'implementation', subject: 'S', objective: 'O', status: 'pending', dependencies: [], inScope: [], outOfScope: [], acceptance: ['a'], verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: 1, updatedAt: 1 })
  state.counters.work = 1
  // Build: ou1(company) > ou2(R&D) > ou3(Backend); ou4(Product)
  state.orgUnits = [
    { id: 'ou1', kind: 'company', name: 'Root', createdAt: 1 },
    { id: 'ou2', kind: 'department', name: 'R&D', parentId: 'ou1', createdAt: 1 },
    { id: 'ou3', kind: 'team', name: 'Backend', parentId: 'ou2', createdAt: 1 },
    { id: 'ou4', kind: 'department', name: 'Product', parentId: 'ou1', createdAt: 1 },
  ]
  // e1: HR (root); e2: engineer in Backend(ou3); e3: PM in Product(ou4)
  state.employees = [
    { ...state.employees[0]!, id: 'e1', isHr: true, orgUnitId: 'ou1', sessionId: 's1', status: 'idle' },
    { ...state.employees[0]!, id: 'e2', isHr: false, orgUnitId: 'ou3', sessionId: 's2', status: 'idle' },
    { ...state.employees[0]!, id: 'e3', isHr: false, orgUnitId: 'ou4', sessionId: 's3', status: 'idle' },
  ]
  const work = state.workItems[0]!
  work.status = 'pending'
  work.assigneeId = undefined
  work.eligibleEmployeeIds = undefined
  work.eligibleOrgUnitIds = ['ou2'] // R&D subtree

  assert.equal(canEmployeeOwn(state, work, 'e2'), true, 'Backend engineer (descendant of R&D) eligible')
  assert.equal(canEmployeeOwn(state, work, 'e3'), false, 'Product PM (different subtree) rejected')
  assert.equal(canEmployeeOwn(state, work, 'e1'), false, 'HR rejected')

  // Unscoped work: non-HR anyone can claim.
  work.eligibleOrgUnitIds = undefined
  assert.equal(canEmployeeOwn(state, work, 'e3'), true)

  // isDescendantOrgUnit sanity
  assert.equal(isDescendantOrgUnit(state, 'ou3', 'ou2'), true)
  assert.equal(isDescendantOrgUnit(state, 'ou3', 'ou1'), true)
  assert.equal(isDescendantOrgUnit(state, 'ou4', 'ou2'), false)
  assert.equal(isDescendantOrgUnit(state, 'ou2', 'ou2'), false, 'strict descendant only')
})

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

test('implementation completion supports Node glob semantics for common brace scopes', () => {
  const state = withImplementationWork()
  const work = state.workItems[0]!
  work.inScope = ['product/**/*.{ts,tsx}']
  const attempt = beginWorkAttempt(state, work, 'e1')
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId: attempt, status: 'in_progress' })
  assert.doesNotThrow(() => updateWork(state, '/workspace', 'e1', {
    workId: work.id,
    attemptId: attempt,
    status: 'completed',
    output: 'Implemented.',
    changedPaths: ['product/components/widget.tsx'],
    acceptanceResults: ['pass'],
  }))
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

test('exhausted pending work does not starve later eligible work', () => {
  const state = withImplementationWork()
  const exhausted = state.workItems[0]!
  exhausted.attempt = state.limits.maxAttemptsPerWork
  state.workItems.push({ ...structuredClone(exhausted), id: 'w2', attempt: 0, createdAt: exhausted.createdAt + 1 })
  assert.ok(workBlockedReasons(state, exhausted, 'e1').includes('attempts_exhausted'))
  assert.equal(selectReadyWork(state, 'e1')?.id, 'w2')
})

test('progress patches retain evidence for a later terminal update', () => {
  const state = withImplementationWork()
  const work = state.workItems[0]!
  const attemptId = beginWorkAttempt(state, work, 'e1')
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId, status: 'in_progress', changedPaths: ['product/index.ts'], commandsRun: ['node --test'] })
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId, output: 'Implemented and tested.', acceptanceResults: ['Tests pass'] })
  assert.deepEqual(work.evidence, { changedPaths: ['product/index.ts'], commandsRun: ['node --test'], acceptanceResults: ['Tests pass'] })
  updateWork(state, '/workspace', 'e1', { workId: work.id, attemptId, status: 'completed' })
  assert.equal(work.status, 'completed')
})

test('review completion may use a previously reported verdict', () => {
  const state = withImplementationWork()
  const reviewed = state.workItems[0]!
  reviewed.status = 'completed'
  reviewed.assigneeId = 'e2'
  state.workItems.push({ ...structuredClone(reviewed), id: 'w2', kind: 'review', reviewedWorkId: reviewed.id, status: 'pending', assigneeId: 'e1' })
  const review = state.workItems[1]!
  const attemptId = beginWorkAttempt(state, review, 'e1')
  updateWork(state, '/workspace', 'e1', { workId: review.id, attemptId, status: 'in_progress', verdict: 'pass', output: 'Reviewed implementation.' })
  updateWork(state, '/workspace', 'e1', { workId: review.id, attemptId, status: 'completed' })
  assert.equal(review.status, 'completed')
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
