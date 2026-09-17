# ADR 0003 — Consumer-owned scheduling

- **Status:** Accepted
- **Date:** 2026-09-17
- **Supersedes:** The active cron policy in [ADR 0001](0001-architecture.md)
  and the concrete provider schedules in [ADR 0002](0002-codex-provider.md).

## Context

The original release used GitHub Actions both as the execution platform and as
the owner of a recurring two-hour policy. ADR 0002 added a second provider and
an arbitrary offset between provider schedules. Those choices made the public
canonical repository capable of automatically spending a credential owner's
subscription allowance according to repository-maintainer timing.

The application cannot observe, start, or reset a provider usage window. It can
only issue an invocation and report its outcome. Because every real invocation
may consume allowance, the owner of the credential and subscription must own
both the decision to recur and the timing policy.

## Decision

Keep the two provider-specific GitHub Actions workflows executable but
manual-only in the canonical repository. Retain `workflow_dispatch`, including
dry-run support, and remove all active `schedule` triggers and maintainer-chosen
cron expressions.

Consumers enable recurrence in their own repository by adding a schedule to
the workflow for each provider they deliberately choose. The maintained
activation guide documents the exact insertion point, prerequisites, UTC and
best-effort semantics, allowance consequences, overlap queueing, disabling,
credential rotation, and upgrade handling. Any cron shown in that guide is
explicitly illustrative rather than a default or recommendation.

The ownership boundary is:

| Owner | Responsibility |
| --- | --- |
| Project | Invocation orchestration, provider adapters, credential and billing-path enforcement, runtime isolation, conservative outcome classification, maintained manual workflows, and scheduling guidance. |
| Consumer | Whether recurrence is enabled, which providers participate, cron or external-scheduler policy, allowance impact, Environment policy, monitoring, and credential rotation. |

Provider selection remains a literal property of each workflow. Provider
Environments, one-secret-per-workflow wiring, read-only permissions,
default-branch controls, immutable action pins, reviewed CLI versions,
installation-before-secret exposure, non-cancelling per-provider concurrency,
and the shared complete exit-code mapping remain unchanged. The workflows keep
their `AGENT_TRIGGER_SOURCE` expression so a consumer-added schedule is
reported as `scheduled` without changing application code.

Scheduling remains outside `src/core/` and provider adapters. The
provider-neutral `TriggerSource` value describes who invoked the application;
it does not create a scheduler or timing policy.

## Why this option

Manual-only maintained workflows are the smallest design that creates explicit
consent while preserving the current, reviewable security boundary and a direct
dry-run/manual validation path. The activation is a visible commit in the
consumer's repository, and the workflow itself remains the deterministic unit
of provider and secret selection.

Inactive templates would make accidental upstream execution structurally
impossible, but the manual-only trigger already prevents recurring execution
while avoiding a copy/install step and template drift. A reusable workflow with
thin scheduled callers would separate policy more formally, but it introduces
secret-passing, Environment, version-selection, and local-action trust
complexity disproportionate to two providers. Scheduling snippets alone would
be too easy to separate from the maintained workflow controls; here the snippet
only adds a trigger to a complete workflow whose controls remain tested.
Non-GitHub schedulers remain architecturally possible, but claiming maintained
support without equivalent testable security artifacts would be misleading.

## Consequences

- The canonical repository performs no recurring provider invocation by
  default. Ordinary credential-free CI remains unchanged.
- Dry runs and real manual invocations remain available. Dry runs do not install
  a CLI, validate a credential, or contact a provider; operators must perform a
  real manual invocation for end-to-end authentication validation.
- Consumers choose schedules in UTC and accept GitHub's best-effort delivery.
  Concurrency prevents simultaneous invocations for one provider but does not
  discard queued runs.
- Consumers who edit a maintained workflow may resolve upgrade conflicts when
  pulling upstream changes. The scheduling guide makes that responsibility and
  the controls that must survive the merge explicit.
- The workflow display names changed from `Usage window trigger (Claude/Codex)`
  to `Provider invocation (Claude/Codex)`. Update runbooks, bookmarks, or
  `gh workflow run` automation that selects a workflow by display name; prefer
  the stable workflow filename where supported.
- Existing forks that relied on the former schedules must add their desired
  schedules explicitly when adopting this change. Removing the old cron
  entries otherwise stops recurrence while preserving manual dispatch.
- Invocation timeout, adapter abort grace, retry backoff, execution budget, job
  timeout, duration reporting, and credential-expiration guidance are technical
  bounds and remain in force; they are not scheduling policy.
