import { BlockList, isIP } from "node:net";

/**
 * A network policy as an agent writes it: eve's `SandboxNetworkPolicy`. The
 * object form denies by default and allows the listed domains and address
 * ranges. A domain may carry rules that set headers on its requests, which
 * is how a credential reaches a service without entering the sandbox.
 * Forwarding rules (`forwardURL`) are refused.
 */
export type BwrapNetworkPolicy = "allow-all" | "deny-all" | BwrapNetworkAllowList;

export interface BwrapNetworkAllowList {
  /**
   * Allowed domains. `example.com` matches that host only, `*.example.com`
   * every subdomain but not the apex, and `*` any domain. The record form
   * maps each domain to the rules applied to its requests; an empty list
   * allows the domain as it is.
   */
  readonly allow?: readonly string[] | Readonly<Record<string, readonly BwrapNetworkRule[]>>;
  readonly subnets?: {
    /** CIDRs reachable by address, without a domain having to be allowed. */
    readonly allow?: readonly string[];
    /** CIDRs never reachable, even through an allowed domain or CIDR. */
    readonly deny?: readonly string[];
  };
}

/**
 * What happens to the requests a domain receives. The first rule whose
 * `match` a request satisfies handles it, and a rule without `match` handles
 * every request; a request no rule matches goes out as the program sent it.
 * The shape is eve's `SandboxNetworkRule`, so `forwardURL` is part of the
 * type, but a policy that uses it is refused.
 */
export type BwrapNetworkRule = {
  readonly match?: BwrapNetworkMatch;
} & (
  | {
      /** Headers to set, replacing any the request already has under the same name. */
      readonly transform: readonly { readonly headers?: Readonly<Record<string, string>> }[];
    }
  | { readonly forwardURL: string }
);

/** Which requests a rule handles. Every part given must match. */
export interface BwrapNetworkMatch {
  /** The request path, without its query string. */
  readonly path?: BwrapNetworkMatcher;
  /** Request methods, any one of which matches. */
  readonly method?: readonly string[];
  /** Query parameters, every one of which some parameter of the request must match. */
  readonly queryString?: readonly BwrapNetworkEntryMatcher[];
  /** Headers, every one of which some header of the request must match. */
  readonly headers?: readonly BwrapNetworkEntryMatcher[];
}

/** Matches one header or query parameter by its name, its value, or both. */
export interface BwrapNetworkEntryMatcher {
  readonly key?: BwrapNetworkMatcher;
  readonly value?: BwrapNetworkMatcher;
}

/**
 * Exactly one of `exact`, `startsWith`, or `regex`. Comparison is
 * case-sensitive, except against a header name. `regex` is a JavaScript
 * regular expression, anchored only where it says so.
 */
export type BwrapNetworkMatcher =
  | { readonly exact: string }
  | { readonly startsWith: string }
  | { readonly regex: string };

/**
 * The canonical, JSON-compatible form a policy is recorded in. Rules carry
 * credentials and are never recorded: `rules` only names the allowed domains
 * that had some.
 */
export type RecordedNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow: readonly string[];
      readonly rules?: readonly string[];
      readonly subnets?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    };

/** The parts of an HTTP request a rule can match on. */
export interface NetworkRequest {
  readonly method: string;
  /** The request target as sent: a path and, after `?`, a query string. */
  readonly target: string;
  /** Header names and values in the order received. */
  readonly headers: readonly (readonly [string, string])[];
}

/** A rule ready to be applied. */
export interface ResolvedNetworkRule {
  matches(request: NetworkRequest): boolean;
  /** The headers to set, lowercased name first, in the order to set them. */
  readonly headers: readonly (readonly [string, string])[];
}

/** A policy ready to decide on destinations. */
export type ResolvedNetworkPolicy =
  | { readonly kind: "allow-all"; readonly recorded: "allow-all" }
  | { readonly kind: "deny-all"; readonly recorded: "deny-all" }
  | {
      readonly kind: "allow-list";
      readonly recorded: Exclude<RecordedNetworkPolicy, string>;
      /** Whether `host`, a DNS name, is on the domain allow-list. */
      allowsDomain(host: string): boolean;
      /**
       * Whether the list holds the catch-all `*`. It admits traffic that names
       * no domain at all, which no other pattern can match.
       */
      readonly allowsAnyDomain: boolean;
      /** Whether any domain carries rules, so some connections have to be read. */
      readonly hasRules: boolean;
      /**
       * The rules for requests to `host`: those of the most specific pattern
       * that matches it, so `github.com` decides over `*.github.com` and that
       * over `*`. Empty when that pattern has none.
       */
      rulesFor(host: string): readonly ResolvedNetworkRule[];
      /** Whether `address`, an IP literal, is in an allowed range. */
      allowsAddress(address: string): boolean;
      /** Whether `address` is in a denied range, which overrides every allow. */
      deniesAddress(address: string): boolean;
    };

const UNSUPPORTED =
  'bwrap sandbox supports the "allow-all" and "deny-all" network policies and allow-lists of ' +
  "domains and subnets, with rules that set request headers";

function refuse(detail: string): never {
  throw new Error(`${UNSUPPORTED}; ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LABEL = /^(?:\*|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;

/**
 * A domain pattern, lowercased and without a trailing dot. A wildcard stands
 * for a whole DNS label, so `api*.example.com` is refused rather than read
 * as something narrower or wider than its author meant.
 */
function normalizeDomain(value: unknown): string {
  if (typeof value !== "string") refuse("a domain must be a string");
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain === "*") return domain;
  const labels = domain.split(".");
  if (domain === "" || domain.length > 253 || !labels.every((label) => LABEL.test(label))) {
    refuse(
      `${JSON.stringify(value)} is not a domain: write a host name, with "*" only in place of a whole label`,
    );
  }
  if (isIP(domain) !== 0)
    refuse(`${JSON.stringify(value)} is an address: list it in subnets.allow`);
  return domain;
}

function matchesDomain(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  const want = pattern.split(".");
  const have = host.split(".");
  if (want[0] === "*") {
    // A leading wildcard covers one or more labels and never the apex.
    const rest = want.slice(1);
    if (have.length <= rest.length) return false;
    return rest.every(
      (label, index) => label === "*" || label === have[have.length - rest.length + index],
    );
  }
  return (
    want.length === have.length &&
    want.every((label, index) => label === "*" || label === have[index])
  );
}

function parseCidr(value: unknown): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
  if (typeof value !== "string") refuse("a subnet must be a CIDR string");
  const [address = "", prefixText, ...extra] = value.trim().split("/");
  const version = isIP(address);
  if (version === 0 || extra.length > 0) refuse(`${JSON.stringify(value)} is not a CIDR`);
  const bits = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!/^\d+$/.test(prefixText ?? String(bits)) || prefix > bits) {
    refuse(`${JSON.stringify(value)} is not a CIDR`);
  }
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function blockList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const { address, prefix, family } = parseCidr(cidr);
    list.addSubnet(address, prefix, family);
  }
  return list;
}

function contains(list: BlockList, address: string): boolean {
  const version = isIP(address);
  return version !== 0 && list.check(address, version === 4 ? "ipv4" : "ipv6");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !keys.includes(key));
}

type Test = (value: string) => boolean;

/** `foldCase` is for header names, the one thing compared without regard to case. */
function compileMatcher(value: unknown, where: string, foldCase = false): Test {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  const unknownKey = hasOnlyKeys(value, ["exact", "startsWith", "regex"]);
  if (unknownKey !== undefined) refuse(`${where}.${unknownKey} is not supported`);
  const given = Object.entries(value).filter(([, operand]) => operand !== undefined);
  if (given.length !== 1 || typeof given[0]![1] !== "string") {
    refuse(`${where} must set exactly one of exact, startsWith, or regex, to a string`);
  }
  const [kind, operand] = given[0] as [string, string];
  const fold = (text: string) => (foldCase ? text.toLowerCase() : text);
  if (kind === "exact") return (text) => fold(text) === fold(operand);
  if (kind === "startsWith") return (text) => fold(text).startsWith(fold(operand));
  let pattern: RegExp;
  try {
    pattern = new RegExp(operand, foldCase ? "i" : "");
  } catch (error) {
    refuse(`${where}.regex is not a regular expression: ${(error as Error).message}`);
  }
  return (text) => pattern.test(text);
}

type EntryTest = (entries: readonly (readonly [string, string])[]) => boolean;

/** Every matcher in the list must be satisfied by some entry, which need not be the same one. */
function compileEntryMatchers(value: unknown, where: string, foldKeyCase: boolean): EntryTest {
  if (!Array.isArray(value)) refuse(`${where} must be a list`);
  const tests = value.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) refuse(`${at} must be an object`);
    const unknownKey = hasOnlyKeys(entry, ["key", "value"]);
    if (unknownKey !== undefined) refuse(`${at}.${unknownKey} is not supported`);
    if (entry.key === undefined && entry.value === undefined) {
      refuse(`${at} must set key, value, or both`);
    }
    const key =
      entry.key === undefined ? undefined : compileMatcher(entry.key, `${at}.key`, foldKeyCase);
    const content =
      entry.value === undefined ? undefined : compileMatcher(entry.value, `${at}.value`);
    return ([name, text]: readonly [string, string]) =>
      (key === undefined || key(name)) && (content === undefined || content(text));
  });
  return (entries) => tests.every((test) => entries.some(test));
}

function queryEntries(target: string): [string, string][] {
  const mark = target.indexOf("?");
  return mark === -1 ? [] : [...new URLSearchParams(target.slice(mark + 1))];
}

function compileMatch(value: unknown, where: string): (request: NetworkRequest) => boolean {
  if (value === undefined) return () => true;
  if (!isRecord(value)) refuse(`${where} must be an object`);
  const unknownKey = hasOnlyKeys(value, ["path", "method", "queryString", "headers"]);
  if (unknownKey !== undefined) refuse(`${where}.${unknownKey} is not supported`);
  const path = value.path === undefined ? undefined : compileMatcher(value.path, `${where}.path`);
  if (
    value.method !== undefined &&
    !(Array.isArray(value.method) && value.method.every((method) => typeof method === "string"))
  ) {
    refuse(`${where}.method must be a list of methods`);
  }
  const methods = value.method as readonly string[] | undefined;
  const query =
    value.queryString === undefined
      ? undefined
      : compileEntryMatchers(value.queryString, `${where}.queryString`, false);
  const headers =
    value.headers === undefined
      ? undefined
      : compileEntryMatchers(value.headers, `${where}.headers`, true);
  return (request) =>
    (methods === undefined || methods.includes(request.method)) &&
    (path === undefined || path(request.target.split("?", 1)[0]!)) &&
    (query === undefined || query(queryEntries(request.target))) &&
    (headers === undefined || headers(request.headers));
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** A value a header may carry: no control character that could end the field. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Headers that frame a request or belong to one connection. Setting one would
 * let a rule desynchronize the request it is applied to from the one sent on.
 */
const FRAMING_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function compileTransform(value: unknown, where: string): [string, string][] {
  if (!Array.isArray(value)) refuse(`${where} must be a list`);
  const headers: [string, string][] = [];
  value.forEach((step, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(step)) refuse(`${at} must be an object`);
    const unknownKey = hasOnlyKeys(step, ["headers"]);
    if (unknownKey !== undefined) refuse(`${at}.${unknownKey} is not supported`);
    if (step.headers === undefined) return;
    if (!isRecord(step.headers)) refuse(`${at}.headers must be an object`);
    for (const [rawName, content] of Object.entries(step.headers)) {
      const name = rawName.toLowerCase();
      // Never the value: it is the credential the rule exists to keep out of sight.
      if (!HEADER_NAME.test(name)) refuse(`${at}.headers has a name that is not a header name`);
      if (FRAMING_HEADERS.has(name)) refuse(`${at}.headers cannot set ${name}`);
      if (typeof content !== "string" || !HEADER_VALUE.test(content)) {
        refuse(`${at}.headers.${name} is not a header value`);
      }
      headers.push([name, content]);
    }
  });
  return headers;
}

function compileRule(value: unknown, where: string): ResolvedNetworkRule {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  if (value.forwardURL !== undefined) {
    refuse(`${where} forwards requests (forwardURL), which is not supported`);
  }
  const unknownKey = hasOnlyKeys(value, ["match", "transform"]);
  if (unknownKey !== undefined) refuse(`${where}.${unknownKey} is not supported`);
  if (value.transform === undefined) refuse(`${where} must set transform`);
  return {
    matches: compileMatch(value.match, `${where}.match`),
    headers: compileTransform(value.transform, `${where}.transform`),
  };
}

/** How narrowly a pattern names a host: more literal labels first, a wildcard-free name first of all. */
function specificity(pattern: string): number {
  const labels = pattern.split(".");
  const literal = labels.filter((label) => label !== "*").length;
  return literal * 2 + (literal === labels.length ? 1 : 0);
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(`${name} must be a list`);
  return value as string[];
}

/**
 * Validates a policy and prepares it for enforcement. Anything this provider
 * cannot enforce throws: a policy is never applied in a weaker form than it
 * was written in.
 */
export function resolveNetworkPolicy(policy: unknown): ResolvedNetworkPolicy {
  if (policy === "allow-all") return { kind: policy, recorded: policy };
  if (policy === "deny-all") return { kind: policy, recorded: policy };
  if (!isRecord(policy)) refuse(`received ${JSON.stringify(policy) ?? String(policy)}`);
  const unknownKey = Object.keys(policy).find((key) => key !== "allow" && key !== "subnets");
  if (unknownKey !== undefined) refuse(`"${unknownKey}" is not supported`);

  const rulesByDomain = new Map<string, readonly ResolvedNetworkRule[]>();
  let domains: string[];
  if (policy.allow === undefined || Array.isArray(policy.allow)) {
    domains = stringList(policy.allow, "allow").map(normalizeDomain);
  } else if (isRecord(policy.allow)) {
    domains = Object.entries(policy.allow).map(([written, rules]) => {
      const domain = normalizeDomain(written);
      const where = `allow[${JSON.stringify(written)}]`;
      if (!Array.isArray(rules)) refuse(`${where} must be a list of rules`);
      const compiled = [
        ...(rulesByDomain.get(domain) ?? []),
        ...rules.map((rule, index) => compileRule(rule, `${where}[${index}]`)),
      ];
      if (compiled.length > 0) rulesByDomain.set(domain, compiled);
      return domain;
    });
  } else {
    refuse("allow must be a list of domains or a record of domains");
  }

  const subnets = policy.subnets;
  if (subnets !== undefined && !isRecord(subnets)) refuse("subnets must be an object");
  const unknownSubnetKey = Object.keys(subnets ?? {}).find(
    (key) => key !== "allow" && key !== "deny",
  );
  if (unknownSubnetKey !== undefined) refuse(`subnets.${unknownSubnetKey} is not supported`);
  const canonicalCidr = (cidr: string) => {
    const { address, prefix } = parseCidr(cidr);
    return `${address}/${prefix}`;
  };
  const allowSubnets = stringList(subnets?.allow, "subnets.allow").map(canonicalCidr);
  const denySubnets = stringList(subnets?.deny, "subnets.deny").map(canonicalCidr);

  const allowed = blockList(allowSubnets);
  const denied = blockList(denySubnets);
  const uniqueDomains = [...new Set(domains)];
  // Most specific first, so the first pattern that matches a host decides its rules.
  const bySpecificity = uniqueDomains
    .map((pattern, index) => ({ pattern, index, rank: specificity(pattern) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ pattern }) => pattern);
  const normalize = (host: string) => host.toLowerCase().replace(/\.$/, "");
  return {
    kind: "allow-list",
    recorded: {
      allow: uniqueDomains,
      ...(rulesByDomain.size > 0
        ? { rules: uniqueDomains.filter((domain) => rulesByDomain.has(domain)) }
        : {}),
      ...(allowSubnets.length > 0 || denySubnets.length > 0
        ? {
            subnets: {
              ...(allowSubnets.length > 0 ? { allow: allowSubnets } : {}),
              ...(denySubnets.length > 0 ? { deny: denySubnets } : {}),
            },
          }
        : {}),
    },
    allowsAnyDomain: uniqueDomains.includes("*"),
    allowsDomain: (host) => {
      const name = normalize(host);
      return uniqueDomains.some((pattern) => matchesDomain(pattern, name));
    },
    hasRules: rulesByDomain.size > 0,
    rulesFor: (host) => {
      const name = normalize(host);
      const decides = bySpecificity.find((pattern) => matchesDomain(pattern, name));
      return (decides === undefined ? undefined : rulesByDomain.get(decides)) ?? [];
    },
    allowsAddress: (address) => contains(allowed, address),
    deniesAddress: (address) => contains(denied, address),
  };
}

/**
 * Reads back a policy in its recorded form, as session state holds it.
 * Anything `resolveNetworkPolicy(...).recorded` could not have produced throws.
 */
export function readRecordedNetworkPolicy(value: unknown): RecordedNetworkPolicy {
  if (!isRecord(value)) return resolveNetworkPolicy(value).recorded;
  const { rules, ...rest } = value;
  const recorded = resolveNetworkPolicy(rest).recorded as Exclude<RecordedNetworkPolicy, string>;
  if (rules === undefined) return recorded;
  if (
    !Array.isArray(rules) ||
    rules.length === 0 ||
    !rules.every((domain) => recorded.allow.includes(domain))
  ) {
    refuse("rules must name allowed domains");
  }
  const { allow, ...others } = recorded;
  return { allow, rules: recorded.allow.filter((domain) => rules.includes(domain)), ...others };
}

/**
 * The policy a recorded one can be restored to on its own: the same domains
 * and ranges, with the domains that carried rules allowed as they are.
 */
export function restorableNetworkPolicy(recorded: RecordedNetworkPolicy): BwrapNetworkPolicy {
  if (typeof recorded === "string") return recorded;
  const { rules: _rules, ...restorable } = recorded;
  return restorable;
}
