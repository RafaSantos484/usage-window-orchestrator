# Consumer-owned scheduling

Recurring execution is optional and disabled in the distributed repository.
The project owns the invocation workflows and their security controls; the
credential owner decides whether recurring invocations should happen, which
providers to enable, and when they run.

The maintained workflows are manual-only until you edit your own repository:

| Provider | Workflow | Environment | Secret |
| --- | --- | --- | --- |
| Claude | `.github/workflows/usage-window-trigger.yml` | `usage-window-claude` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `.github/workflows/usage-window-trigger-codex.yml` | `usage-window-codex` | `CODEX_ACCESS_TOKEN` |

Enable only providers whose subscription and credential you own. Each real
manual or scheduled invocation may consume that provider's subscription
allowance.

## Before enabling recurrence

For each provider you intend to use:

1. Create its GitHub Environment and restrict deployments to the protected
   default branch. Store only that provider's secret in that Environment.
2. Dispatch its workflow with `dry_run: true`. This validates non-secret
   configuration, deterministic provider selection, and orchestration wiring.
   It does **not** install the provider CLI, validate CLI availability, inspect
   or validate the credential, contact the provider, or prove live provider
   behavior.
3. Dispatch it once with `dry_run: false`. This is the required end-to-end
   authentication check and may consume allowance. A successful invocation
   proves that the provider completed according to the adapter's reviewed
   success contract; it does not prove that a usage window started, changed,
   or reset. Provider success contracts can differ: for example, Claude also
   accepts a clean, non-error turn-limit result as success, while Codex requires
   one non-empty agent response.
4. Review the result, concurrency behavior, expected allowance consumption,
   and—when using Codex—the access token's expiration date. Codex access-token
   rotation remains an operator responsibility and is required at least every
   90 days.

The README contains the complete credential, billing, branch-protection, and
rotation instructions. Scheduling does not replace any of them.

## Enable a GitHub Actions schedule

Edit only the workflow for the provider you want to run. Under its top-level
`on:` key, add a `schedule` block alongside the existing
`workflow_dispatch` block:

```yaml
on:
  schedule:
    # Illustrative example only: weekdays at 06:23 UTC.
    # It is not a default or recommendation; choose your own policy.
    - cron: "23 6 * * 1-5"
  workflow_dispatch:
    # Keep the existing inputs unchanged.
```

Replace the example with a cron expression chosen for your subscription
allowance and operating needs. Commit the change to the protected default
branch. Do not add a provider-selection input: the selected workflow file
deterministically selects its provider and exposes only that provider's secret.

GitHub Actions cron is UTC and does not follow local daylight-saving changes.
Scheduled delivery is best-effort: runs can be delayed, particularly during
high load, and GitHub may disable scheduled workflows after prolonged
repository inactivity. Do not rely on precise delivery or use timing as
evidence of provider quota-window state.

Keep the existing provider-specific `concurrency` declaration and
`cancel-in-progress: false`. If a run for that provider is already active, a
new scheduled or manual run queues instead of cancelling an invocation that
may already have consumed allowance. Concurrency prevents overlap; it does not
deduplicate queued runs. Every queued run that later starts may consume
allowance. Claude and Codex use separate groups and may run concurrently; use a
shared group only if your own policy requires cross-provider exclusion.

After activation, monitor Actions results and credential expiry. A dry run is
useful after non-secret configuration changes, but only a real manual run can
revalidate authentication or a rotated credential.

## Disable recurrence

Remove the `schedule` block from the provider workflow and commit that change
to the default branch. This preserves manual dispatch for dry runs and explicit
invocations. GitHub's **Disable workflow** control stops both scheduled and
manual runs, so use it only when you want the entire provider workflow off.

If you enable both providers, remove both schedule blocks to stop all recurring
invocations. Revoking or deleting a credential is an emergency security action,
not a substitute for removing the schedule: leaving recurrence enabled would
continue to create failing runs.

## Upgrades and other schedulers

A schedule added to a maintained workflow is a consumer-owned customization and
can conflict with later upstream workflow changes. When updating from upstream,
review the complete workflow diff, retain your chosen trigger only if you still
want recurrence, and preserve the Environment, secret scope, permissions,
runtime pins, default-branch controls, concurrency declaration, and shared
outcome-classification step. The display names changed from `Usage window
trigger (Claude/Codex)` to `Provider invocation (Claude/Codex)`; update any
runbook or `gh workflow run` automation that selects by display name and prefer
the stable workflow filename where supported.

The CLI can also be invoked manually or by another trusted scheduler because
scheduling does not exist in `src/core/` or the provider adapters. Such a
deployment is not represented by a maintained integration artifact here. Its
operator is responsible for equivalent secret isolation, least privilege,
timeouts, non-cancelling overlap protection, reviewed CLI pins, redaction, and
safe result handling.
