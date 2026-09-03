# dsh-company architecture

Status: implementation contract
Target: DeepSeek Harness `@deepseek-ai/dsh@0.1.1-rc.2` (rc.2)
Scope: one bounded AI software company per canonical workspace

## 0. Trust model summary

- **Session identity is the only authority.** Every mutation names an exact live participant (founder session, or the designated HR/support employee for scoped operations). Enumerable ids are never authority by themselves; the runtime re-verifies liveness, role, and company binding inside each revision-fenced transaction.
- **Web parity with the host settings page.** Loopback same-origin pages act as the session participant they name (full view + mutations, persisted). Remote clients — only reachable when `allowRemoteUi` is enabled — are strictly read-only and receive a downgraded projection. A local process that can reach the loopback port is in the same trust domain as one that can edit host settings or state files directly.
- **Reservations are accounting units, never truncation devices.** Since v0.13 there are no per-turn token limits: output is never clamped or blocked mid-turn; overruns are recorded post-hoc and halt the company only when spending exceeds the money budget.
- **Employees cannot escalate.** Tool filters deny founder-only `company_*` tools and every spawn-capable native tool (`subagent`, `subagent_fork`, `ralph`, `workflow`, `agent_teams_create`). Headcount changes flow exclusively through HR staffing with human approval.

## 1. Boundaries

`dsh-company` is a Cordis Host + Web client plugin. It composes DSH instead of implementing another agent runtime:

- one exact live root session is Founder;
- direct durable continuable subagents are employees (reserved session ids, full transcripts in DSH session storage);
- formation, governance, HR staffing, organization, products, work, tickets, approvals, messages, factual usage, monetary authority and health are durable company state;
- an event-driven scheduler admits only ready work, HR assessments or mail, and cold-recovers open attempts after restarts with the same capability;
- safe browser projections never carry attempt capabilities, execution prompts, credentials or endpoints.

It does not perform legal incorporation, provider billing, payroll, purchases, credential management, deployment, publication or irreversible external effects. Company approval and temporary authorization never bypass Harness sandbox or Host/user approval.

## 2. DSH seams

- `ctx.tools.register(defineTool(...))` — closed Host tools (see README table);
- `ctx.systemPrompt.section(...)` — founder / HR / employee policy, including the restart-resume protocol (never recreate employee personas) and the no-self-spawn rule;
- `ctx.subagents.startContinuable() / followup() / interrupt()` — durable employees; `followup` cold-resumes via `agents.resume(resumeSessionId)` restoring the full transcript;
- `ctx.llm.listProviders() / listModels() / resolveModelInfo() / resolveCallConfig()` — capability discovery and route validation; `llm/adapters-updated` + `settings/document-updated` invalidate cached projections;
- `agent/request` — route capture, temporary-authorization validation, call-headroom renewal; per-turn blocking and max_tokens clamping are deliberately absent;
- `session/event` — ingest `assistant/message` `TokenUsage` into the money/token ledgers;
- `agent/request-error`, `agent/error`, `agent/status` — failure classification, reservation cleanup, scheduling;
- Web server registration — `GET /plugins/dsh-company/state` (participant-aware, snake_case projection) and `POST /plugins/dsh-company/action` (loopback-only mutation channel; remote 403 `web_mutations_require_loopback`), plus the console-decision steer into the founder conversation.

Model discovery is advisory: an exact configured route remains valid when absent from an advertised catalog; discovery creates capability rows, never invented prices.

## 3. Durable aggregate

Filesystem path and state `schemaVersion: 1` stay stable; normalization is idempotent (v0.13 strips legacy turn-token fields). The browser snapshot contract is `schema_version: 4` (v0.4 removed flat `departments`; v0.5 added the Host-parsed `company.charter_outline`; v0.9 added `tickets`).

```ts
interface CompanyState {
  phase: 'staged' | 'provisioning' | 'provisioning_failed' |
    'operating' | 'paused' | 'halted' | 'closing' | 'archived'
  name: string; slogan: string; mission: string
  governanceRevision: number
  formation: { status: 'draft' | 'approved'; charter: string; … }
  moneyBudget: {
    currency: string                 // immutable after usage
    totalMicros / reservedMicros / spentMicros
    pricingRevision: number
    prices: ModelPrice3[]            // three-rate rows, revision-fenced
    usage / reservations             // factual ledger
  }
  tokenBudget: TokenBudget           // legacy v0.1 ledger, kept in step
  modelCatalog: { generation, probedAt, models[] }
  orgUnits / positions / employees   // hierarchical org; manager attribution
  staffingRequests                   // HR pipeline with recommendations
  products / workItems               // scope-bounded products; DAG work
  tickets                            // filed → triaged → dispatched → resolved → closed
  approvals / temporaryAuthorizations
  supportEmployeeId?                 // designated ticket decider
  health / provisioning / audit
}
```

Every mutation runs in `store.transact`: revision fence → audit row appended first → state written atomically; a failed audit append aborts the mutation. Mailbox writes stage before the state commit and roll back on failure.

## 4. Money & accounting

- Authority is integer micro-currency. Tools/Web accept human units (≤6 decimals, exact decimal→micro conversion) converted once at the Host boundary.
- Admission (`reserveMoneyTurn`) reserves worst-case prompt+output money for a turn. Entitlement sizing (v0.13) is context-window driven — min across primary/fallback route context windows — and by affordability at the tightest of company/product/employee budgets. Unknown-cost routes require a temporary authorization bypass and book a 1M-token placeholder.
- `agent/request` validates that the requested route was captured by the reservation and that the covering authorization is still active; it renews call headroom when remaining micros fall short. It never injects or clamps `max_tokens`.
- `session/event` settles factual usage: per-entry cost from an immutable rate snapshot at the reservation's pricing revision; one aggregate BigInt half-up rounding; reasoning tokens never double-charged. Overspend is persisted first, then the company halts (`money_budget`) with employee operational blocks; manual resume after correction.
- Price edits apply only to future calls (`pricing_change` approval, digest-fenced); recorded usage keeps its original revision. Currency is immutable after any usage.

## 5. Organization & staffing

- Org units are hierarchical (company/division/department/team) with manager attribution; the flat v1 `departments` projection is gone.
- Every hire/adjust/retire starts at `company_request_staffing`; the designated HR lead claims the assessment and recommends difficulty, provider/model (must be an enabled, three-rate-priced route), reasoning effort, employee monetary ceiling, org path, position and responsibilities. A human approves the `organization_change`; the founder applies it. Employee provisioning reserves the continuable session id and installs persona + tool filter.
- Employee tool filters deny all founder-only `company_*` tools and the spawn-capable native tools; the founder policy forbids recreating employee personas after restarts and routes headcount requests to HR.

## 6. Work lifecycle

- Work items carry kind (discovery…operations), product scope, acceptance, verification, deliverables, dependencies (acyclic, validated), optional approval dependencies, and review independence (`review` requires a differing assignee).
- The scheduler preclaims ready work for idle employees (reserve → begin attempt → deliver prompt); employees confirm with `company_claim_work` and update through `company_update_work` with the exact attempt capability. Terminal updates require kind-specific evidence (changed paths within scope, acceptance results).
- Reassignment revokes the old capability and completes a fenced handoff. Pause interrupts members, releases reservations and requeues without consuming attempts. Cold recovery re-delivers the same attempt after host restarts; failed/cancelled repairs return their ticket to triaged.

## 7. Tickets (v0.9)

Human-filed tickets from the Web console create a linked, unassigned `repair` work item (blocked from admission by `ticket_awaiting_dispatch` until dispatch). Triage sets severity; dispatch assigns a runnable employee (never the founder — hard check). Completion auto-resolves the ticket and steers the founder to reply and close (`company_close_ticket`, reply defaulting to the work output). Failure returns the ticket to triaged with severity kept. A designated support engineer (`company_designate_support`) may run the whole loop without the founder.

## 8. Web console

- Mounts via official slots (conversation header button + shell overlay). One fiber-owned controller polls `/state` and posts `/action`; duplicate React mounts never multiply requests.
- Loopback founder view renders the editable formation form, approvals, ticket filing, the recruiting price matrix with model-id-keyed presets (never auto-enabling), and pause/resume/archive. Every successful console action steers the founder conversation with an authoritative record; ticket resolution steers too.
- Remote views downgrade: employee viewer, empty permissions, private evidence stripped, an explicit read-only banner.

## 9. Failure taxonomy & health

Scoped operational blocks (`money_budget`, `unpriced_model`, provider/network classes) pause the affected employee with a reason; company `halted` requires manual resume. Provisioning failure keeps the formation editable for retry. Archive preserves transcripts, revokes capabilities and reconciles reservations; forced archive consumes its approval only on success.

## 10. Testing

`pnpm verify` = typecheck (host + client) + node:test suites + build (tsc + tsdown) + package check. Suites pin: money rounding and migration, reservation/settlement and overrun halt, unknown-cost authorization fences, catalog probing, org load oracle, snapshot redaction, web action execution/steer and remote fail-closed, ticket lifecycle, charter parsing, render trees, price presets, tool-filter denials, and cold recovery.
