import { describe, expect, test } from "vitest";
import { resolveNetworkPolicy } from "./network-policy.js";

function allowList(policy: unknown) {
  const resolved = resolveNetworkPolicy(policy);
  if (resolved.kind !== "allow-list")
    throw new Error(`expected an allow-list, got ${resolved.kind}`);
  return resolved;
}

describe("resolveNetworkPolicy", () => {
  test("keeps the two coarse policies as they are", () => {
    expect(resolveNetworkPolicy("allow-all")).toEqual({ kind: "allow-all", recorded: "allow-all" });
    expect(resolveNetworkPolicy("deny-all")).toEqual({ kind: "deny-all", recorded: "deny-all" });
  });

  test("an exact domain matches that host only", () => {
    const policy = allowList({ allow: ["example.com"] });
    expect(policy.allowsDomain("example.com")).toBe(true);
    expect(policy.allowsDomain("EXAMPLE.com.")).toBe(true);
    expect(policy.allowsDomain("www.example.com")).toBe(false);
    expect(policy.allowsDomain("badexample.com")).toBe(false);
    expect(policy.allowsDomain("example.com.evil.test")).toBe(false);
  });

  test("a leading wildcard matches every subdomain and never the apex", () => {
    const policy = allowList({ allow: ["*.example.com"] });
    expect(policy.allowsDomain("www.example.com")).toBe(true);
    expect(policy.allowsDomain("www.api.example.com")).toBe(true);
    expect(policy.allowsDomain("example.com")).toBe(false);
    expect(policy.allowsDomain("wwwexample.com")).toBe(false);
  });

  test("a wildcard inside a domain stands for exactly one label", () => {
    const policy = allowList({ allow: ["www.*.com"] });
    expect(policy.allowsDomain("www.example.com")).toBe(true);
    expect(policy.allowsDomain("www.a.b.com")).toBe(false);
    expect(policy.allowsDomain("api.example.com")).toBe(false);
  });

  test("a lone wildcard matches any domain", () => {
    expect(allowList({ allow: ["*"] }).allowsDomain("anything.test")).toBe(true);
  });

  test("an empty allow-list allows no domain", () => {
    expect(allowList({}).allowsDomain("example.com")).toBe(false);
    expect(allowList({ allow: [] }).recorded).toEqual({ allow: [] });
  });

  test("subnets decide on addresses, and a denied range is reported separately", () => {
    const policy = allowList({
      allow: ["example.com"],
      subnets: { allow: ["10.0.0.0/8", "2001:db8::/32"], deny: ["10.1.0.0/16", "169.254.169.254"] },
    });
    expect(policy.allowsAddress("10.2.3.4")).toBe(true);
    expect(policy.allowsAddress("2001:db8::1")).toBe(true);
    expect(policy.allowsAddress("192.168.1.1")).toBe(false);
    expect(policy.deniesAddress("10.1.2.3")).toBe(true);
    expect(policy.deniesAddress("169.254.169.254")).toBe(true);
    expect(policy.deniesAddress("10.2.3.4")).toBe(false);
    expect(policy.allowsAddress("not-an-address")).toBe(false);
  });

  /** The recorded form is what a restarted process resolves again. */
  test("records a canonical JSON form that resolves to the same policy", () => {
    const { recorded } = allowList({
      allow: { "API.Example.com": [], "*.example.com": [], "api.example.com": [] },
      subnets: { allow: ["10.0.0.1"] },
    });
    expect(recorded).toEqual({
      allow: ["api.example.com", "*.example.com"],
      subnets: { allow: ["10.0.0.1/32"] },
    });
    expect(allowList(JSON.parse(JSON.stringify(recorded))).recorded).toEqual(recorded);
  });

  /**
   * A policy is never applied in a weaker form than it was written in: what
   * cannot be enforced is refused, with a reason an agent author can act on.
   */
  test.each([
    [
      { allow: { "github.com": [{ transform: [{ headers: { authorization: "x" } }] }] } },
      /rules on a domain/,
    ],
    [{ allow: { "github.com": [{ forwardURL: "https://proxy.test" }] } }, /rules on a domain/],
    [{ allow: ["api*.example.com"] }, /is not a domain/],
    [{ allow: ["https://example.com"] }, /is not a domain/],
    [{ allow: ["example.com:443"] }, /is not a domain/],
    [{ allow: ["10.0.0.1"] }, /subnets\.allow/],
    [{ allow: [42] }, /must be a string/],
    [{ allow: "example.com" }, /list of domains or a record/],
    [{ subnets: { allow: ["10.0.0.0/33"] } }, /is not a CIDR/],
    [{ subnets: { deny: ["example.com"] } }, /is not a CIDR/],
    [{ subnets: { block: [] } }, /subnets\.block is not supported/],
    [{ allow: [], ports: [443] }, /"ports" is not supported/],
    ["allow-some", /received "allow-some"/],
    [null, /received null/],
  ])("refuses %j", (policy, reason) => {
    expect(() => resolveNetworkPolicy(policy)).toThrow(reason);
    expect(() => resolveNetworkPolicy(policy)).toThrow(/allow-all.*deny-all/);
  });

  /** Only the catch-all admits traffic that names no domain; no other pattern can match it. */
  test("allowsAnyDomain is true for a list holding the catch-all alone", () => {
    const any = resolveNetworkPolicy({ allow: ["example.com", "*"] });
    const some = resolveNetworkPolicy({ allow: ["*.example.com"] });
    expect(any.kind === "allow-list" && any.allowsAnyDomain).toBe(true);
    expect(some.kind === "allow-list" && some.allowsAnyDomain).toBe(false);
  });
});
