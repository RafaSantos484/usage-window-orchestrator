# Adding a provider

Claude is the only implemented provider. The provider boundary exists because
the task requires future providers without coupling orchestration to a CLI.
Evolve it when a real second integration reveals a demonstrated variation.

## Checklist

1. Add an adapter under `src/providers/<id>/` implementing `AgentProvider`.
2. Keep command construction, credentials, native output parsing, and
   provider-specific error strings inside that adapter.
3. Add the provider id and construction branch in `src/main.ts`.
4. Add its workflow choice, secret wiring, and runtime installation if needed.
5. Add tests for command construction, credentials, output classification,
   redaction, and the allowlisted child environment.

Do not change `src/core/` for provider-specific behavior. Return the existing
normalized `ProviderOutcome` statuses; add provider detail only through a safe
diagnostic code and summary. `TRANSIENT_FAILURE` is retryable, so use it only
when the provider proves the request was not accepted. Tests must not contact
the real provider or require real secrets.
