# Adding a provider

Claude and Codex are implemented. The provider boundary exists because the task
requires future providers without coupling orchestration to a CLI.

The Codex integration was the first real test of that boundary and it required
**no provider-neutral contract or runtime change in `src/core/`** — only
clarifying comments were updated in `src/core/invocation.ts`. It uses the same
`InvocationRequest`, same eight
`InvocationStatus` values, same retry policy, same metadata shape. That is the
bar: if a third provider forces a core change, the change needs the kind of
justification an ADR carries, not a convenient extra field. See
[ADR 0002](adr/0002-codex-provider.md) for what the second integration did and
did not change.

## Checklist

1. Add an adapter under `src/providers/<id>/` implementing `AgentProvider`.
2. Keep command construction, credentials, child-process environment, runtime
   isolation, native output parsing, and provider-specific error strings inside
   that adapter. Put pure parsing and classification in a separate
   `classify.ts` so it can be tested without a process.
3. Add a `ProviderDescriptor` to the `DESCRIPTORS` list in
   `src/providers/catalog.ts`: the id, the provider-owned `secretEnvNames`
   inventory, a billing-credential detector,
   the operator-facing billing warning, and a constructor. `PROVIDER_IDS`
(which `loadConfig` validates against) and the global redaction inventory
derive from that list.
Keep `ProviderDescriptor` limited to facts required by the composition root.
Provider-native capabilities, command options, output rules, and runtime policy
remain inside the adapter rather than becoming catalog fields.
4. Raise `ProviderConfigurationError` (from
   `src/providers/provider-configuration-error.ts`) for a missing or
   unacceptable credential. The composition root maps it to exit code 20.
5. Add its own **manual-only** workflow file with its own concurrency group,
   reviewed CLI version pin, and provider-specific GitHub Environment. The
   canonical repository must not ship an active `schedule` trigger. Store the
   credential as an environment secret and configure that environment to
   permit deployment only from the protected default branch. Keep the in-file
   guard and explicit
   default-branch checkout as defense in depth. Document the consumer scheduling
   activation point in [the scheduling guide](scheduling.md), while keeping the
   provider literal in the workflow so selection cannot depend on an input — see
   [ADR 0003](adr/0003-consumer-owned-scheduling.md).
   Reuse `.github/actions/classify-outcome`. Add the workflow to the table in
   `tests/workflows.test.ts`.
6. Add tests for command construction, credential refusal, the exact child
   environment, runtime isolation and cleanup, output classification, and
   redaction.
7. Update the README's provider support matrix, configuration tables,
   troubleshooting section and *Provider differences that matter*.

## Rules that are not negotiable

**Do not change `src/core/` for provider-specific behavior.** Return the
existing normalized `ProviderOutcome` statuses; add provider detail only
through a safe diagnostic code and summary. A new status has to be justified
across the whole application, not by one provider's error taxonomy.

**`TRANSIENT_FAILURE` is retryable, so use it only when the provider proves the
request was not accepted** — a DNS failure or a refused connection. Anything
post-connection (stream drops, upstream 5xx, timeouts) and anything ambiguous
(malformed output, generic rate limits) is `UNKNOWN_FAILURE`. A retry spends
real allowance.

If process startup reports both a spawn error and an aborted deadline, classify
the spawn error first: the provider entry point was not executable, so
`PROVIDER_UNAVAILABLE` is more precise than `TIMEOUT`. This precedence is part
of the existing process boundary and should remain consistent across adapters.

**Do not infer success from a zero exit code alone** if the CLI can report
failure with one. Require positive structured evidence that the provider
accepted the invocation and met its reviewed success contract. If that contract
requires a response, require response evidence; for a single-turn provider
whose contract exposes one, require exactly one clean terminal turn with exactly
one non-empty response and no unknown events.

**Do not derive a passing or retryable result from arbitrary prose.** For Codex,
usage-limit claims require an exact structured error discriminant. A provider
may use a bounded native message for a provider-specific outcome only when its
reviewed contract explicitly establishes that field as trustworthy and the
exception is documented. Prompt echoes and stderr must never create a passing
or retryable outcome. The existing Claude adapter has two reviewed,
provider-specific text fallbacks: its usage-limit matcher and its
pre-connection network matcher for the narrow `ENOTFOUND`, `EAI_AGAIN`, and
`ECONNREFUSED` tokens. The latter produces `TRANSIENT_FAILURE` only under the
reviewed Claude contract and may be a conservative false positive if those
fields can contain echoed prompt text. These legacy exceptions must not be
generalized to Codex or new providers; revisit them if the provider contract
cannot establish the fields' provenance.

**Do not claim a usage window from a rate limit.** If the output does not
distinguish "your plan's allowance is exhausted" from "you are being throttled",
use `UNKNOWN_FAILURE` with an honest diagnostic. The product never asserts
quota state it cannot observe.

**Subscription credentials only.** If the provider's only unattended credential
bills through a metered API account, that is a blocker to document, not a
default to ship. Refuse API-key-shaped values at construction, never use the
API-key variables for authentication or forward them, and withhold them from
the child environment explicitly. The composition root may inspect their
presence and read their values only for redaction.

**The child process gets an allowlist, never the job environment.** Fresh
temporary `HOME`, temp and working directories per invocation, plus whatever
per-provider state directory the CLI needs. Never run in the checked-out
repository, and disable mutation and tool execution if the CLI supports it.
The shared process runner bounds stdout and stderr and reports truncation;
classifiers must fail closed when output needed to establish the outcome was
dropped.

**For the Codex outcome, nothing sensitive is reproduced.** No prompt, no
response text, no credential, no session or thread identifier, no filesystem
content, or arbitrary environment value. Provider output is untrusted even
when it comes from an error event or stderr. Use only allowlisted scalar fields
and exact discriminants for classification, and fixed summaries for diagnostics — see
`src/providers/codex/classify.ts` for the enforced pattern.

This specific no-quoting guarantee applies to the Codex classifier. Other
providers may use a redacted, bounded excerpt when their adapter's contract
requires it; that excerpt must still pass the shared secret-redaction boundary.

**Tests must not contact the real provider or require real secrets.** Use
sanitized representative output inline, and clean up anything the adapter
creates on disk.
