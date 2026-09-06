import assert from 'node:assert/strict'
import test from 'node:test'
import { loadOrganizationSnapshot, loadRunningSnapshot } from '../src/client/directory-snapshot.js'
import { parseCompanySnapshot, type CompanySnapshot, type SnapshotPage, type SnapshotQuery } from '../src/client/types.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

function directoryFixture(employeeCount = 301, unitCount = 151, positionCount = 201): (query?: SnapshotQuery) => CompanySnapshot {
  const base = parseCompanySnapshot(snapshotFixture())
  const units = Array.from({ length: unitCount }, (_, index) => ({ ...structuredClone(base.org_units[0]!), id: `ou${index}`, parent_id: index === 0 ? undefined : 'ou0', child_ids: [], position_ids: [] }))
  const positions = Array.from({ length: positionCount }, (_, index) => ({ ...structuredClone(base.positions[0]!), id: `pos${index}`, org_unit_id: `ou${index % unitCount}`, employee_ids: [] }))
  const employees = Array.from({ length: employeeCount }, (_, index) => ({ ...structuredClone(base.employees[0]!), id: `e${index}`, name: `Engineer ${index}`, position_id: `pos${index % positionCount}`, org_unit_id: `ou${index % positionCount % unitCount}` }))
  const page = <T>(rows: T[], offset = 0, limit = 100): { rows: T[]; page: SnapshotPage } => {
    const result = rows.slice(offset, offset + limit)
    return { rows: result, page: { total: rows.length, filtered_total: rows.length, offset, limit, returned: result.length, next_offset: offset + result.length < rows.length ? offset + result.length : null } }
  }
  return (query = {}) => {
    const employeePage = page(employees, query.employeeOffset, query.employeeLimit)
    const unitPage = page(units, query.orgOffset, query.orgLimit)
    const positionPage = page(positions, query.positionOffset, query.positionLimit)
    return {
      ...structuredClone(base),
      employees: employeePage.rows,
      org_units: unitPage.rows,
      positions: positionPage.rows,
      directory: {
        employees: { ...employeePage.page, query },
        org_units: unitPage.page,
        positions: positionPage.page,
        summary: { employees: employeeCount, active_employees: employeeCount, retired_employees: 0, running_employees: employeeCount, org_units: unitCount, positions: positionCount, employee_statuses: { working: employeeCount } },
      },
    }
  }
}

test('organization assembles all bounded pages and rebuilds cross-page tree relationships', async () => {
  const page = directoryFixture()
  const first = page()
  const queries: SnapshotQuery[] = []
  let fetching = false
  const snapshot = await loadOrganizationSnapshot(first, async (query) => {
    assert.equal(fetching, false)
    fetching = true
    queries.push(query)
    await Promise.resolve()
    fetching = false
    return page(query)
  })
  assert.deepEqual([snapshot.employees.length, snapshot.org_units.length, snapshot.positions.length], [301, 151, 201])
  assert.equal(queries.length, 3)
  assert.ok(queries.every((query) => query.employeeLimit === 100 && query.orgLimit === 100 && query.positionLimit === 100))
  assert.equal(snapshot.org_units[0]!.child_ids.length, 150)
  assert.ok(snapshot.org_units[49]!.position_ids.includes('pos200'))
  assert.ok(snapshot.positions[200]!.employee_ids.includes('e200'))
  assert.ok(snapshot.positions[99]!.employee_ids.includes('e300'))
  assert.equal(snapshot.employees[300]!.org_unit_id, 'ou99')
  assert.equal(snapshot.budget, first.budget)
  assert.equal(snapshot.work, first.work)
  assert.deepEqual(first.org_units[0]!.child_ids, [], 'assembling presentation data does not mutate a cached wire page')
})

test('organization excludes retired employees from occupied position references', async () => {
  const page = directoryFixture(3, 2, 1)
  const first = page()
  first.employees[2]!.status = 'retired'
  const snapshot = await loadOrganizationSnapshot(first, async () => assert.fail('a complete first page needs no request'))
  assert.deepEqual(snapshot.positions[0]!.employee_ids, ['e0', 'e1'])
  assert.equal(snapshot.employees.length, 3)
})

test('organization refuses pages from another revision, company, or viewer', async () => {
  for (const change of [
    (snapshot: CompanySnapshot) => { snapshot.revision += 1 },
    (snapshot: CompanySnapshot) => { snapshot.company.id = 'another-company' },
    (snapshot: CompanySnapshot) => { snapshot.viewer.participant_id = 'another-viewer' },
    (snapshot: CompanySnapshot) => { snapshot.viewer.permissions = [] },
  ]) {
    const page = directoryFixture()
    await assert.rejects(loadOrganizationSnapshot(page(), async (query) => {
      const next = page(query)
      change(next)
      return next
    }), /directory changed.*Refresh/u)
  }
})

test('directory assembly rejects duplicate or nonadvancing pages instead of silently losing rows', async () => {
  const page = directoryFixture()
  let calls = 0
  await assert.rejects(loadOrganizationSnapshot(page(), async () => { calls += 1; return page() }), /directory changed/u)
  assert.equal(calls, 1)
  await assert.rejects(loadOrganizationSnapshot(page(), async (query) => {
    const next = page(query)
    next.employees = next.employees.map((employee) => ({ ...employee, id: 'duplicate' }))
    return next
  }), /directory changed/u)
})

test('running employees accumulate the requested prefix without carrying unrelated filters', async () => {
  const page = directoryFixture(350)
  const first = page({ employeeStatus: 'running', employeeLimit: 100 })
  const queries: SnapshotQuery[] = []
  const snapshot = await loadRunningSnapshot(first, 205, async (query) => {
    queries.push(query)
    return page(query)
  })
  assert.equal(snapshot.employees.length, 205)
  assert.equal(snapshot.employees[204]!.id, 'e204')
  assert.deepEqual(queries, [
    { employeeStatus: 'running', employeeOffset: 100, employeeLimit: 100 },
    { employeeStatus: 'running', employeeOffset: 200, employeeLimit: 5 },
  ])
  assert.equal(snapshot.org_units, first.org_units)
  assert.equal(snapshot.directory!.summary.running_employees, 350)
  await assert.rejects(loadRunningSnapshot(page({ employeeStatus: 'running', employeeSearch: 'Engineer 1' }), 200, async (query) => page(query)), /directory changed/u)
})

test('running employees stop at the available total and reject changing live-page counts', async () => {
  const page = directoryFixture(120)
  const first = page({ employeeStatus: 'running', employeeLimit: 100 })
  const snapshot = await loadRunningSnapshot(first, 200, async (query) => page(query))
  assert.equal(snapshot.employees.length, 120)
  await assert.rejects(loadRunningSnapshot(first, 200, async (query) => {
    const next = page(query)
    next.directory!.employees.filtered_total -= 1
    return next
  }), /directory changed/u)
})

test('directory loading preserves legacy snapshots and propagates cancellation failures', async () => {
  const legacy = parseCompanySnapshot(snapshotFixture())
  const unexpected = async (): Promise<CompanySnapshot> => assert.fail('legacy snapshots need no request')
  assert.equal(await loadOrganizationSnapshot(legacy, unexpected), legacy)
  assert.equal(await loadRunningSnapshot(legacy, 5, unexpected), legacy)
  const page = directoryFixture()
  const cancelled = new Error('request cancelled')
  const cancel = async (): Promise<CompanySnapshot> => { throw cancelled }
  await assert.rejects(loadOrganizationSnapshot(page(), cancel), (error) => error === cancelled)
  await assert.rejects(loadRunningSnapshot(page({ employeeStatus: 'running' }), 200, cancel), (error) => error === cancelled)
})
