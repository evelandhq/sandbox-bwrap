/**
 * Thrown when a session needs a template that was never prepared.
 *
 * eve recognizes this error structurally, by `name`, `providerName`, and
 * `templateKey`, so this package can throw it without importing eve at run
 * time.
 */
export class BwrapTemplateNotProvisionedError extends Error {
  override readonly name = "SandboxTemplateNotProvisionedError";
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

/**
 * Thrown by `resume` when the session's workspace no longer exists. eve
 * recognizes it by `name` and starts a fresh sandbox for the session instead
 * of failing every later sandbox call.
 */
export class BwrapSandboxSessionGoneError extends Error {
  override readonly name = "SandboxSessionGoneError";
}
