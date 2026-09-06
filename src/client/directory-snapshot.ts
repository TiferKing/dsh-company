import type { CompanySnapshot, SnapshotDirectory, SnapshotPage, SnapshotQuery } from './types.js'

type FetchPage = (query: SnapshotQuery) => Promise<CompanySnapshot>
type DirectoryKey = 'employees' | 'org_units' | 'positions'
const PAGE_LIMIT = 100
const DIRECTORY_KEYS: DirectoryKey[] = ['employees', 'org_units', 'positions']

function changed(): never {
  throw new Error('Company directory changed while loading. Refresh to retry.')
}

function sameIdentity(first: CompanySnapshot, next: CompanySnapshot): void {
  if (next.company.id !== first.company.id || next.revision !== first.revision || next.schema_version !== first.schema_version
    || next.viewer.role !== first.viewer.role || next.viewer.participant_id !== first.viewer.participant_id
    || [...next.viewer.permissions].sort().join('\u0000') !== [...first.viewer.permissions].sort().join('\u0000')) changed()
}

function assertPage(page: SnapshotPage, rows: readonly unknown[], offset: number, total: number): void {
  if (page.offset !== offset || page.filtered_total !== total || page.limit < 1 || page.limit > PAGE_LIMIT
    || page.returned !== rows.length || rows.length !== Math.min(page.limit, Math.max(0, total - offset))
    || page.next_offset !== (offset + rows.length < total ? offset + rows.length : null)) changed()
}

function assertUnfiltered(query: SnapshotQuery, running: boolean): void {
  if (query.employeeSearch !== undefined || query.employeeId !== undefined || query.employeeOrgUnitId !== undefined
    || query.employeePositionId !== undefined || query.employeeExactStatus !== undefined
    || (running ? query.employeeStatus !== 'running' : query.employeeStatus !== undefined && query.employeeStatus !== 'all')
    || (!running && (query.orgId !== undefined || query.positionId !== undefined))) changed()
}

function addRows<T extends { id: string }>(target: Map<string, T>, rows: readonly T[]): void {
  for (const row of rows) target.set(row.id, row)
}

/** Assemble a presentation-only tree from validated, bounded wire pages. */
export async function loadOrganizationSnapshot(first: CompanySnapshot, fetchPage: FetchPage): Promise<CompanySnapshot> {
  if (first.directory === undefined) return first
  assertUnfiltered(first.directory.employees.query, false)
  const initial = first.directory
  const employees = new Map(first.employees.map((row) => [row.id, row]))
  const units = new Map(first.org_units.map((row) => [row.id, row]))
  const positions = new Map(first.positions.map((row) => [row.id, row]))
  for (const key of DIRECTORY_KEYS) {
    if (initial[key].filtered_total !== initial[key].total) changed()
    assertPage(initial[key], first[key], 0, initial[key].total)
  }
  let current: SnapshotDirectory = initial
  // Each subsequent page advances by 100 rows or finishes that collection.
  const maxPages = Math.max(...DIRECTORY_KEYS.map((key) => Math.ceil(initial[key].total / PAGE_LIMIT)))
  for (let round = 0; DIRECTORY_KEYS.some((key) => current[key].next_offset !== null); round += 1) {
    if (round >= maxPages) changed()
    const query: SnapshotQuery = {
      employeeOffset: current.employees.next_offset ?? current.employees.offset,
      employeeLimit: PAGE_LIMIT,
      orgOffset: current.org_units.next_offset ?? current.org_units.offset,
      orgLimit: PAGE_LIMIT,
      positionOffset: current.positions.next_offset ?? current.positions.offset,
      positionLimit: PAGE_LIMIT,
    }
    const next = await fetchPage(query)
    sameIdentity(first, next)
    if (next.directory === undefined) changed()
    assertUnfiltered(next.directory.employees.query, false)
    for (const key of DIRECTORY_KEYS) {
      const offset = key === 'employees' ? query.employeeOffset! : key === 'org_units' ? query.orgOffset! : query.positionOffset!
      if (next.directory[key].total !== initial[key].total || next.directory[key].limit !== PAGE_LIMIT) changed()
      assertPage(next.directory[key], next[key], offset, initial[key].total)
    }
    addRows(employees, next.employees)
    addRows(units, next.org_units)
    addRows(positions, next.positions)
    current = next.directory
  }
  if (employees.size !== initial.employees.total || units.size !== initial.org_units.total || positions.size !== initial.positions.total) changed()

  const childrenByParent = new Map<string, string[]>()
  const positionsByUnit = new Map<string, string[]>()
  const employeesByPosition = new Map<string, string[]>()
  const append = (map: Map<string, string[]>, parent: string, id: string): void => {
    const ids = map.get(parent) ?? []
    ids.push(id)
    map.set(parent, ids)
  }
  for (const unit of units.values()) if (unit.parent_id !== undefined) append(childrenByParent, unit.parent_id, unit.id)
  for (const position of positions.values()) append(positionsByUnit, position.org_unit_id, position.id)
  for (const employee of employees.values()) if (employee.status !== 'retired' && employee.position_id !== undefined) append(employeesByPosition, employee.position_id, employee.id)
  // directory still describes the first wire page; these assembled arrays are
  // client presentation data and are never sent back through the wire parser.
  return {
    ...first,
    employees: [...employees.values()],
    org_units: [...units.values()].map((unit) => ({ ...unit, child_ids: childrenByParent.get(unit.id) ?? [], position_ids: positionsByUnit.get(unit.id) ?? [] })),
    positions: [...positions.values()].map((position) => ({ ...position, employee_ids: employeesByPosition.get(position.id) ?? [] })),
  }
}

/** Fetch only the requested visible prefix of the live-running employee list. */
export async function loadRunningSnapshot(first: CompanySnapshot, visibleCount: number, fetchPage: FetchPage): Promise<CompanySnapshot> {
  if (first.directory === undefined) return first
  if (!Number.isSafeInteger(visibleCount) || visibleCount < 1) throw new Error('Visible employee count must be a positive integer.')
  assertUnfiltered(first.directory.employees.query, true)
  const initial = first.directory.employees
  assertPage(initial, first.employees, 0, initial.filtered_total)
  const target = Math.min(visibleCount, initial.filtered_total)
  const employees = new Map(first.employees.map((row) => [row.id, row]))
  let current = initial
  const maxPages = Math.ceil(target / PAGE_LIMIT)
  for (let round = 0; employees.size < target && current.next_offset !== null; round += 1) {
    if (round >= maxPages) changed()
    const query: SnapshotQuery = { employeeStatus: 'running', employeeOffset: current.next_offset, employeeLimit: Math.min(PAGE_LIMIT, target - employees.size) }
    const next = await fetchPage(query)
    sameIdentity(first, next)
    if (next.directory === undefined) changed()
    assertUnfiltered(next.directory.employees.query, true)
    if (next.directory.employees.total !== initial.total || next.directory.employees.limit !== query.employeeLimit) changed()
    assertPage(next.directory.employees, next.employees, query.employeeOffset!, initial.filtered_total)
    addRows(employees, next.employees)
    current = next.directory.employees
  }
  if (employees.size < target) changed()
  return { ...first, employees: [...employees.values()].slice(0, target) }
}
