import { describe, expect, test } from "vitest";
import {
  readRecordedNetworkPolicy,
  resolveNetworkPolicy,
  restorableNetworkPolicy,
  type NetworkRequest,
} from "./network-policy.js";

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
    [{ allow: { "github.com": [{ forwardURL: "https://proxy.test" }] } }, /forwardURL/],
    [{ allow: { "github.com": [{ response: { statusCode: 403 } }] } }, /response is not supported/],
    [{ allow: { "github.com": [{}] } }, /must set transform/],
    [{ allow: { "github.com": "none" } }, /must be a list of rules/],
    [{ allow: { "github.com": [{ transform: [{ body: "x" }] }] } }, /body is not supported/],
    [{ allow: { "github.com": [{ transform: [{ headers: { "a b": "x" } }] }] } }, /header name/],
    [
      { allow: { "github.com": [{ transform: [{ headers: { "Content-Length": "0" } }] }] } },
      /cannot set content-length/,
    ],
    [
      { allow: { "github.com": [{ transform: [{ headers: { authorization: "a\r\nx: y" } }] }] } },
      /is not a header value/,
    ],
    [
      { allow: { "github.com": [{ match: { path: {} }, transform: [] }] } },
      /exactly one of exact, startsWith, or regex/,
    ],
    [
      { allow: { "github.com": [{ match: { path: { exact: "/", regex: "/" } }, transform: [] }] } },
      /exactly one of exact, startsWith, or regex/,
    ],
    [
      { allow: { "github.com": [{ match: { path: { regex: "(" } }, transform: [] }] } },
      /is not a regular expression/,
    ],
    [
      { allow: { "github.com": [{ match: { headers: [{}] }, transform: [] }] } },
      /must set key, value, or both/,
    ],
    [
      { allow: { "github.com": [{ match: { method: "GET" }, transform: [] }] } },
      /must be a list of methods/,
    ],
    [{ allow: { "github.com": [{ match: { host: {} }, transform: [] }] } }, /match\.host/],
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

  /** A refusal names where the policy went wrong and never repeats a header value. */
  test("a refused rule does not echo the credential it carried", () => {
    const secret = "ghp_never\nprinted";
    let message = "";
    try {
      resolveNetworkPolicy({
        allow: { "github.com": [{ transform: [{ headers: { authorization: secret } }] }] },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/headers\.authorization is not a header value/);
    expect(message).not.toContain("ghp_never");
  });
});

function request(
  method: string,
  target: string,
  headers: readonly (readonly [string, string])[] = [],
): NetworkRequest {
  return { method, target, headers };
}

describe("rules", () => {
  const bearer = [{ transform: [{ headers: { Authorization: "Bearer real" } }] }];

  test("a domain's rules are those of the most specific pattern that matches", () => {
    const policy = allowList({
      allow: { "*": [], "*.example.com": bearer, "open.example.com": [], "github.com": bearer },
    });
    expect(policy.hasRules).toBe(true);
    expect(policy.rulesFor("github.com")).toHaveLength(1);
    expect(policy.rulesFor("GitHub.com.")).toHaveLength(1);
    expect(policy.rulesFor("api.example.com")).toHaveLength(1);
    // The exact name decides over the wildcard that also matches it.
    expect(policy.rulesFor("open.example.com")).toEqual([]);
    expect(policy.rulesFor("elsewhere.test")).toEqual([]);
    expect(allowList({ allow: { "github.com": [] } }).hasRules).toBe(false);
  });

  test("header names are lowercased and steps apply in order", () => {
    const [rule] = allowList({
      allow: {
        "github.com": [
          {
            transform: [
              { headers: { Authorization: "one", "X-Extra": "1" } },
              {},
              { headers: { authorization: "two" } },
            ],
          },
        ],
      },
    }).rulesFor("github.com");
    expect(rule!.headers).toEqual([
      ["authorization", "one"],
      ["x-extra", "1"],
      ["authorization", "two"],
    ]);
    expect(rule!.matches(request("GET", "/"))).toBe(true);
  });

  test("every part of a match must hold, with any one of the methods", () => {
    const [rule] = allowList({
      allow: {
        "api.test": [
          {
            match: { method: ["POST", "PUT"], path: { startsWith: "/v1/" } },
            transform: [],
          },
        ],
      },
    }).rulesFor("api.test");
    expect(rule!.matches(request("POST", "/v1/items?x=1"))).toBe(true);
    expect(rule!.matches(request("PUT", "/v1/"))).toBe(true);
    expect(rule!.matches(request("GET", "/v1/items"))).toBe(false);
    expect(rule!.matches(request("post", "/v1/items"))).toBe(false);
    expect(rule!.matches(request("POST", "/v2/items"))).toBe(false);
  });

  test("a path is matched without its query string", () => {
    const [exact] = allowList({
      allow: { "api.test": [{ match: { path: { exact: "/a" } }, transform: [] }] },
    }).rulesFor("api.test");
    expect(exact!.matches(request("GET", "/a?b=c"))).toBe(true);
    expect(exact!.matches(request("GET", "/A"))).toBe(false);
    const [pattern] = allowList({
      allow: { "api.test": [{ match: { path: { regex: "^/repos/[^/]+$" } }, transform: [] }] },
    }).rulesFor("api.test");
    expect(pattern!.matches(request("GET", "/repos/eve"))).toBe(true);
    expect(pattern!.matches(request("GET", "/repos/eve/issues"))).toBe(false);
  });

  test("header names match without regard to case and values with it", () => {
    const [rule] = allowList({
      allow: {
        "api.test": [
          {
            match: {
              headers: [
                {
                  key: { exact: "Authorization" },
                  value: { regex: "^(?:token|Bearer) placeholder$" },
                },
                { key: { startsWith: "x-" } },
              ],
            },
            transform: [],
          },
        ],
      },
    }).rulesFor("api.test");
    const matching = [
      ["AUTHORIZATION", "Bearer placeholder"],
      ["X-Trace", "1"],
    ] as const;
    expect(rule!.matches(request("GET", "/", matching))).toBe(true);
    expect(
      rule!.matches(request("GET", "/", [["authorization", "bearer placeholder"], matching[1]])),
    ).toBe(false);
    // Every matcher needs a header of its own to satisfy it.
    expect(rule!.matches(request("GET", "/", [matching[0]]))).toBe(false);
    // Any one of a repeated header's values is enough.
    expect(rule!.matches(request("GET", "/", [["authorization", "other"], ...matching]))).toBe(
      true,
    );
  });

  test("query parameters match decoded, by name and value with regard to case", () => {
    const [rule] = allowList({
      allow: {
        "api.test": [
          {
            match: { queryString: [{ key: { exact: "ref" }, value: { exact: "a b" } }] },
            transform: [],
          },
        ],
      },
    }).rulesFor("api.test");
    expect(rule!.matches(request("GET", "/x?ref=a%20b"))).toBe(true);
    expect(rule!.matches(request("GET", "/x?ref=other&ref=a+b"))).toBe(true);
    expect(rule!.matches(request("GET", "/x?Ref=a%20b"))).toBe(false);
    expect(rule!.matches(request("GET", "/x"))).toBe(false);
  });

  /** A header value is a credential: it reaches the gateway and nothing that is written down. */
  test("the recorded form names the domains with rules and none of their content", () => {
    const { recorded } = allowList({
      allow: { "*": [], "github.com": bearer, "api.github.com": bearer },
      subnets: { deny: ["10.0.0.0/8"] },
    });
    expect(recorded).toEqual({
      allow: ["*", "github.com", "api.github.com"],
      rules: ["github.com", "api.github.com"],
      subnets: { deny: ["10.0.0.0/8"] },
    });
    expect(JSON.stringify(recorded)).not.toContain("real");
    const read = readRecordedNetworkPolicy(JSON.parse(JSON.stringify(recorded)));
    expect(read).toEqual(recorded);
    expect(restorableNetworkPolicy(read)).toEqual({
      allow: ["*", "github.com", "api.github.com"],
      subnets: { deny: ["10.0.0.0/8"] },
    });
    expect(restorableNetworkPolicy("deny-all")).toBe("deny-all");
  });

  test("a recorded form no policy could have produced is refused", () => {
    expect(readRecordedNetworkPolicy("allow-all")).toBe("allow-all");
    expect(readRecordedNetworkPolicy({ allow: ["a.test"] })).toEqual({ allow: ["a.test"] });
    expect(() => readRecordedNetworkPolicy({ allow: ["a.test"], rules: ["b.test"] })).toThrow(
      /rules must name allowed domains/,
    );
    expect(() => readRecordedNetworkPolicy({ allow: ["a.test"], rules: "a.test" })).toThrow(
      /rules must name allowed domains/,
    );
    expect(() => readRecordedNetworkPolicy({ allow: ["a.test"], ports: [1] })).toThrow(/ports/);
  });
});
