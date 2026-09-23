/**
 * Thrown when a session needs a template that was never prepared.
 *
 * eve recognizes this error structurally rather than by class, so this package
 * can throw it without importing eve at runtime. `name` and `templateKey` are
 * checked by every eve line; `backendName` is what eve 0.62 and 0.63 look for,
 * and `providerName` is what 0.64 and later look for. It carries both, so
 * the same error works for the backend and the provider.
 */
export class BwrapTemplateNotProvisionedError extends Error {
  override readonly name = "SandboxTemplateNotProvisionedError";
  readonly backendName = "bwrap";
  readonly providerName = "bwrap";
  readonly templateKey: string;

  constructor(input: { readonly templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is not provisioned for bwrap. ` +
        "Run `eve build` before serving traffic.",
    );
    this.templateKey = input.templateKey;
  }
}
