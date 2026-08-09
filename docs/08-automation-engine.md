# Tessera — Automation Engine Design

## 1. Model

An **automation** is a versioned, directed acyclic graph of steps owned by a base.

```
Automation (stable identity, name, enabled)
  └── AutomationVersion (immutable snapshot: trigger + graph + settings)
        ├── Trigger        exactly one
        └── Step[]         actions, conditions, branches, loops, delays
              └── each step: id, type, config, inputMapping, onError, next[]
```

Editing a published automation creates a **draft version**. Publishing makes the draft the active
version; in-flight runs continue on the version they started with. Version history is browsable
and restorable. This is the difference between an automation platform and a toy: a user must be
able to change a live workflow without corrupting running executions.

## 2. Triggers

| Trigger | Source | Notes |
|---|---|---|
| `record.created` | domain event | Optional view/condition filter |
| `record.updated` | domain event | Watch-list of field ids; fires only if a watched field changed |
| `record.matches_conditions` | domain event | Fires on transition into the condition set, not on every save |
| `record.enters_view` / `record.leaves_view` | computed on write | Membership diff evaluated by the dispatcher |
| `form.submitted` | domain event | Carries the submission id |
| `comment.created` | domain event | |
| `status.changed` | domain event | Sugar over `record.updated` on a status field, exposes from/to |
| `schedule.at` / `schedule.recurring` | scheduler tick | Cron or interval + timezone; see jobs doc §5 |
| `webhook.received` | inbound HTTP | Unique URL + optional shared secret; payload available to steps |
| `button.clicked` | user action | Manual run from a grid button field or interface button |

**Loop protection.** Every run carries a `causationChain` of automation version ids. If an
automation appears in its own chain, or the chain exceeds depth 5, the run halts with
`AUTOMATION_LOOP_DETECTED` and notifies the owner. Without this, "when record updated → update
record" is an infinite money-burning machine.

## 3. Actions

| Action | Notes |
|---|---|
| `record.create` / `record.update` / `record.delete` | Executed with the automation's **service principal**, whose permissions are the intersection of the automation owner's rights and the automation's declared scopes |
| `record.find` | Returns up to 100 records into the run context for later steps |
| `record.link` / `record.unlink` | |
| `email.send` | Templated; from a verified domain; rate-limited per org |
| `notification.send` | In-app to users/groups |
| `webhook.call` | SSRF-guarded, signed, 10 s timeout, response body (≤64 KB) available downstream |
| `slack.message` / `teams.message` | Via the integration connection |
| `calendar.event.create` | Google/Microsoft |
| `document.generate` | Template → PDF via the worker |
| `data.transform` | Safe formula expressions over the run context — the same engine as formula fields |
| `flow.delay` | Durable: the run is persisted and re-enqueued at the target time. Max 30 days |
| `flow.branch` | Conditional branches, first match wins, optional default |
| `flow.loop` | Over an array, capped at 1,000 iterations, sequential or bounded-parallel |
| `flow.run_workflow` | Call a reusable workflow (sub-automation), depth-capped |

## 4. Execution

```
domain event
  → automation-dispatcher (consumer group on the event stream)
      match against automation_triggers (indexed by base + event type + watched fields)
      evaluate trigger conditions against the record
      INSERT automation_runs (unique on (automationVersionId, triggerEventId))  ← idempotency
      enqueue automation.step for the entry node
  → step worker
      load run + version + context
      resolve inputMapping (templating over trigger data + prior step outputs)
      execute the step behind its timeout
      persist automation_run_steps: input, output, status, duration, error   (secrets redacted)
      enqueue the next node(s), or finish the run
```

**Why a step is a job, not a loop inside one job:** durability. A worker crash mid-workflow loses
one step attempt, not the whole run. Delays are free (the run simply is not enqueued). And a
long-running run cannot occupy a worker slot for 30 days.

## 5. Reliability requirements → implementation

| Requirement | Implementation |
|---|---|
| Idempotency | Unique index `(automation_version_id, trigger_event_id)` on runs; each step's job id is `hash(runId, stepId, attempt)`; external side-effect steps take a Redis guard before acting |
| Retry with exponential backoff | Per-step policy (default 3 attempts, 2^n × 5 s, jitter). Retries re-execute only the failed step, using the persisted input — earlier steps never re-run |
| Dead-letter queue | Terminal step failure → run status `failed`, envelope to `dlq:automation`, owner notified, replayable from the console |
| Execution timeout | 30 s per step (600 s for `document.generate`), 15 min per run excluding delays |
| Rate limits | Per-org runs/minute and steps/minute from plan entitlements; over-limit runs are queued, then shed with a clear message |
| Per-tenant usage limits | `automation_runs` metered into `usage_events`; the dispatcher refuses new runs when the plan's monthly allowance is exhausted, with an in-app warning at 80% |
| Detailed logs | Every step persists input, output, status, duration, and error, viewable in a timeline UI |
| Input/output inspection | JSON viewer per step with a diff against the previous run |
| Secret redaction | Values sourced from integration credentials or `secret` config are wrapped in a `Secret<T>` box; the serialiser writes `"[redacted]"`. Redaction is applied at persistence, not at display, so secrets never land in the database |
| Manual reruns | Rerun from the start, or resume from a chosen step with the persisted context |
| Test mode | Runs the graph against a chosen record with all external side effects stubbed and clearly labelled; produces the same step logs |
| Draft/published versions | See §1 |
| Version history | `automation_versions` retained; restore creates a new version copying an old one |
| Duplicate prevention on retry | The trigger event id is the dedupe key end to end; a redelivered event produces a conflict on the unique index and is dropped |

## 6. Data model

```
automations            id, base_id, organization_id, name, enabled, active_version_id, created_by
automation_versions    id, automation_id, version, trigger jsonb, graph jsonb, status(draft|published),
                       published_at, published_by, notes
automation_triggers    id, automation_version_id, base_id, event_type, table_id, watched_field_ids[],
                       condition jsonb          ← the dispatcher's index
automation_schedules   automation_version_id, cron, timezone, next_run_at        ← indexed for the tick
automation_runs        id, automation_version_id, organization_id, trigger_event_id, status,
                       started_at, finished_at, duration_ms, error_code, context jsonb
                       UNIQUE (automation_version_id, trigger_event_id)
automation_run_steps   id, run_id, step_id, attempt, status, input jsonb, output jsonb,
                       error jsonb, started_at, finished_at
```

`automation_runs` and `automation_run_steps` are range-partitioned monthly; retention follows the
plan (7 / 30 / 90 / 365 days).

## 7. Templating / expression binding

Step inputs are templates over the run context:

```
{{trigger.record.fields.Email}}
{{steps.find_customer.records[0].id}}
{{formula: CONCATENATE("Hi ", {{trigger.record.fields.Name}}, "!")}}
```

The `formula:` prefix routes to the same interpreter as formula fields — one expression language
in the product, one security review. Plain `{{path}}` interpolation is a pure property lookup with
no execution.

## 8. Observability

Metrics: runs started/completed/failed by trigger type, step duration histogram by action type,
queue wait time, retry rate, DLQ depth, per-org run volume. Alerts on failure rate > 5% over
15 min, DLQ growth, and dispatcher consumer lag.
