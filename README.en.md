# dsh-company

> Decision-driven AI software company orchestration for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) — with HR governance, monetary budgets, work DAGs, tickets, approvals, and a full Web console.

`dsh-company` turns the current root session into a **Founder**, durable continuable subagents into **employees**, and organizes software development through a real company: staged formation with human approval, HR-first hiring, multi-level org tree, currency-denominated budgets, a three-rate model price matrix, dependency-DAG work items with attempt fencing, human tickets, typed approvals, and an immutable audit ledger.

Target host: `@deepseek-ai/dsh@0.1.1-rc.2` (DSH rc.2).

---

## Why

Delegation fails when the "CEO" agent starts doing the work itself, spawns untracked lookalike helpers, or burns budget without a ledger. dsh-company makes every one of those failure modes structurally impossible:

| Failure mode | Structural answer |
|---|---|
| Founder does the coding itself | Work is admitted only to registered employees; dispatch is hard-denied to `founder` |
| Untracked lookalike subagents | Employees are tool-filter-denied from `subagent`/`workflow`/`ralph`; headcount only via HR staffing + human approval |
| Unbounded spend | Worst-rate monetary reservation at admission; overruns persisted then halt; three-rate price matrix with revision fencing |
| Silent truncation of agent output | Per-turn limits were removed (v0.13): reservations are accounting units, never truncation devices — output is capped only by the model's real capability |
| Lost decisions | Every mutation is revision-fenced, audit-logged (`events.jsonl`), and typed approvals capture human statements |
| "Free" unknown models | Unpriced routes block admission unless covered by a time-bounded, revocable temporary authorization recorded as unknown-cost |

## Feature highlights

- **Decision-first formation** — the AI drafts name/slogan/mission/charter/first-product/budgets/prices; a human edits and explicitly approves before anything starts. Bootstrap provisions exactly one HR lead.
- **HR governance** — every hire, route change, or retirement starts with an HR assessment (difficulty, provider/model, reasoning effort, employee budget, org path, position), then a human-approved `organization_change`.
- **Charter as structured data** — the Host parses the charter text into a clause tree (`company.charter_outline`); the Web renders it as an expandable tree with zero client-side parsing.
- **Recruiting page** — per-model enable switches (default off = 未启用) gate hiring: HR may only recommend enabled (three-rate priced) routes. Built-in price presets for OpenAI / DeepSeek / Zhipu BigModel models (USD/CNY matched) prefill on enable — presets never auto-enable anything.
- **Tickets** — humans file product-issue tickets from the Web console; the founder (or a designated support engineer) triages and dispatches; the linked repair work auto-resolves the ticket; closing replies to the human.
- **Monetary-first accounting** — integer micro-currency is the authority; the Web sends human units (≤6 decimals), converted once at the Host boundary. Deterministic BigInt aggregation, one half-up rounding; reasoning tokens are never double-charged.
- **Audit** — company/product budgets, spent/reserved/available, lifetime per-route cost charts, and a bounded audit detail window over the append-only event log.
- **Web console parity with settings** — loopback same-origin pages act as the session participant (edit/approve/dispatch, persisted directly); remote clients are strictly read-only. Every console decision steers the founder conversation with an authoritative record.
- **Cold recovery discipline** — employees are durable continuable sessions; after host restarts the scheduler recovers open work with the SAME attempt. The founder is explicitly instructed never to recreate employee personas.

## Install

Requirements: Node `^22.19.0 || >=24`, pnpm, a running DSH rc.2 host.

```bash
git clone https://github.com/<you>/dsh-company.git
cd dsh-company
pnpm install
pnpm verify        # typecheck + test + build + package:check
pnpm pack          # produces dsh-company-<version>.tgz

dsh plugin --profile/web add /absolute/path/to/dsh-company-<version>.tgz
```

Restart the existing DSH Web process and refresh the original URL — do not start a replacement server.

## Quick start

   A complete example you can paste directly:

   > Form a company and appoint you as its CEO. The mission is "bring knowledge to everyone"; the first product is "an AI-based generative learning platform". Total budget 300 CNY with 250 CNY for the product. Set up Product, R&D, and QA departments with staffing; start with product definition — spare no budget on the product manager role, I want the best product definition — then hire architects, developers, and testers to match the defined features. Operate the company and report product progress and competitiveness regularly.

1. **Ask for a company** — in a DSH session whose workspace is your product repo, tell the agent to form a company with a concrete mission. It drafts the full proposal via `company_bootstrap` (staged; nothing starts).

2. **Review & approve** — open the Web console (company button in the session header). Edit the proposal in the Overview form (or let the agent apply `company_edit_formation`), then approve. Only the HR lead is provisioned.
3. **Enable models on the Recruiting page** — switch on the routes HR may recommend; preset prices prefill; submit for approval.
4. **Hire through HR** — `company_request_staffing` → HR claims and submits an assessment → you approve the `organization_change` → the founder applies the hire.
5. **Plan work, file tickets** — work items form a dependency DAG with acceptance criteria; product feedback goes to the Tickets tab and is dispatched as repair work by decision.
6. **Watch the money** — the Audit page shows budgets, reservations, and per-route lifetime costs; every mutation lands in the audit ledger.

## The Web console

Tabs: **概览 / 组织 / 产品 / 工作 / 工单 / 招聘 / 审计 / 审批** (Overview, Organization, Products, Work, Tickets, Recruiting, Audit, Approvals).

- Overview — slogan & mission, the charter tree, blocked work, live activity.
- Organization — collapsible org tree with load bands, inline members, per-unit subtree money and model distribution, manager attribution, employee detail with authorization panels.
- Tickets — human filing form + status groups (awaiting triage/dispatch, resolved-awaiting-close, closed with reply).
- Recruiting — the enable-switch price matrix described above.
- Audit — money stats, usage cost charts, bounded audit detail.
- Approvals — decision cards: approval content up front, scope summary and details collapsed by default.

Remote browsers see a read-only downgrade; loopback pages get the full participant view and mutations (see [Host/Web contract](#hostweb-contract--security)).

## Host tools

| Tool | Who | Purpose |
|---|---|---|
| `company_bootstrap` / `company_edit_formation` / `company_approve` | Founder | Stage / edit / approve the formation proposal |
| `company_request_staffing` / `company_claim_staffing_assessment` / `company_submit_staffing_assessment` | Founder / HR | HR-governed hiring pipeline |
| `company_add_employee` / `company_remove_employee` / `company_apply_staffing_adjustment` | Founder | Apply approved org changes |
| `company_create_work` / `company_edit_work` / `company_reassign_work` | Founder | Work DAG planning |
| `company_claim_work` / `company_update_work` | Employees | Attempt-fenced execution and evidence |
| `company_send_message` | Participants | Durable cross-participant messaging (untrusted-data framed) |
| `company_request_approval` / `company_resolve_approval` | Participants / Founder | Typed human approvals |
| `company_request_budget_change` / `company_request_governance_change` / `company_reprobe_models` | Founder | Budget & pricing approvals, catalog re-probe |
| `company_triage_ticket` / `company_dispatch_ticket` / `company_close_ticket` / `company_designate_support` | Founder / Support | Ticket lifecycle |
| `company_grant_temporary_authorization` / `company_revoke_temporary_authorization` | Founder | Bounded unknown-cost authorization |
| `company_control` / `company_status` | Founder / Participants | Pause/resume/archive; role-filtered snapshots |

## State & data

```
~/.dsh/dsh-company/v1/workspaces/<workspace-hash>/
├── identity.json      # workspace anchor (canonical path + sha256)
├── active/            # the operating company
│   ├── company.json   # full state (schemaVersion 1)
│   ├── events.jsonl   # append-only audit ledger (one row per mutation)
│   └── mailboxes/     # per-participant durable inboxes
└── archive/<id>/      # archived companies (same layout)
```

Employee conversation transcripts live in DSH session storage (`~/.dsh/sessions/`), keyed by their reserved session ids — restarts resume them with full context.

## Host/Web contract & security

- `GET /plugins/dsh-company/state?sessionId=…` — snake_case projection. Loopback same-origin pages receive the session's real participant view (founder gets the editable founder view); remote clients (only reachable with `allowRemoteUi`) receive a downgraded read-only view with private evidence stripped.
- `POST /plugins/dsh-company/action` — loopback pages execute as the named session participant (revision-fenced; runtime re-verifies the exact live founder and company binding). Remote clients fail closed (`403 web_mutations_require_loopback`). Successful console decisions steer the founder conversation.
- Snapshots never contain attempt capabilities, execution prompts, credentials, or private work evidence. Temporary authorizations never alter DSH tool permissions or sandbox.

## Development

```bash
pnpm verify          # typecheck && test && build && package:check
pnpm test            # node:test suites under test/
pnpm build           # tsc (host+client) + tsdown bundle
```

CI runs the same `pnpm verify` gate on every push and PR (see `.github/workflows/ci.yml`).

### Releasing

1. Bump `version` in `package.json` **and** the matching assertion in `scripts/verify-package.mjs`.
2. Run `pnpm verify && pnpm pack`.
3. Tag `v<version>` and push; the release workflow attaches the tarball to a GitHub Release.
4. Install with `dsh plugin --profile/web add <tarball>`.

## License

MIT — see [LICENSE](LICENSE).
