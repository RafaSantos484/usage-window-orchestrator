/**
 * A provider adapter refused to be constructed: a required credential is
 * missing, or the supplied credential is not usable for the billing path this
 * project is built around.
 *
 * Shared by every adapter so the composition root has exactly one error type
 * to map onto `ExitCode.CONFIG_ERROR`. Messages are operator-facing and must
 * stay free of credential values.
 */
export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}
