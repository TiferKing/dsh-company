import assert from 'node:assert/strict'
import test from 'node:test'
import { availableCredits, commitReservation, productCreditsUsed, reconcilePreparedReservations, releaseReservation, reserveCredits, routeCost } from '../src/budget.js'
import { companyState } from './fixtures.js'

test('budget reserve, commit, and release preserve aggregates', () => {
  const state = companyState()
  const first = reserveCredits(state, 3, 'work-dispatch', { employeeId: 'e1', workId: seedWork(state) })
  assert.equal(state.budget.reservedCredits, 3)
  assert.equal(availableCredits(state), 97)
  assert.equal(commitReservation(state, first), 3)
  assert.equal(state.budget.spentCredits, 3)
  assert.equal(state.budget.reservedCredits, 0)
  assert.equal(productCreditsUsed(state, 'p1'), 3)

  const second = reserveCredits(state, 2, 'message-delivery', { employeeId: 'e1', messageId: 'message' })
  assert.equal(releaseReservation(state, second), 2)
  assert.equal(state.budget.reservedCredits, 0)
  assert.equal(state.budget.spentCredits, 3)
})

test('crash-left prepared reservations reconcile conservatively once', () => {
  const state = companyState()
  const reservation = reserveCredits(state, 4, 'employee-onboarding', { employeeId: 'e1' })
  assert.deepEqual(reconcilePreparedReservations(state), [reservation])
  assert.equal(state.budget.spentCredits, 4)
  assert.deepEqual(reconcilePreparedReservations(state), [])
})

test('fallback route reserves the higher configured activation cost', () => {
  const cost = routeCost({ routeCosts: { 'p/m': 2, 'f/m2': 7 }, defaultActivationCredits: 1 }, {
    provider: 'p', model: 'm', fallback: { provider: 'f', model: 'm2' },
  })
  assert.equal(cost, 7)
})

function seedWork(state: ReturnType<typeof companyState>): string {
  state.workItems.push({
    id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Implement', objective: 'Implement bounded change',
    status: 'pending', dependencies: [], inScope: ['product'], outOfScope: [], acceptance: ['Tests pass'], verify: ['Run tests'], deliverables: ['Code'],
    attempt: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  })
  state.counters.work = 1
  return 'w1'
}
