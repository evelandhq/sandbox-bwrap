import { BlockList, isIP } from "node:net";

/**
 * A network policy as an agent writes it: eve's `SandboxNetworkPolicy`,
 * narrowed to what this provider can enforce. The object form denies by
 * default and allows the listed domains and address ranges. Rules on a domain
 * (header transforms, forwarding) need TLS to be terminated at the boundary,
 * which this provider does not do, so a domain's rule list must be empty.
 */
export type BwrapNetworkPolicy = "allow-all" | "deny-all" | BwrapNetworkAllowList;

export interface BwrapNetworkAllowList {
  /**
   * Allowed domains. `example.com` matches that host only, `*.example.com`
   * every subdomain but not the apex, and `*` any domain. The record form is
   * eve's; each domain's rule list must be empty.
   */
  readonly allow?: readonly string[] | Readonly<Record<string, readonly unknown[]>>;
  readonly subnets?: {
    /** CIDRs reachable by address, without a domain having to be allowed. */
    readonly allow?: readonly string[];
    /** CIDRs never reachable, even through an allowed domain or CIDR. */
    readonly deny?: readonly string[];
  };
}

/** The canonical, JSON-compatible form a policy is recorded in. */
export type RecordedNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow: readonly string[];
      readonly subnets?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    };

/** A policy ready to decide on destinations. */
export type ResolvedNetworkPolicy =
  | { readonly kind: "allow-all"; readonly recorded: "allow-all" }
  | { readonly kind: "deny-all"; readonly recorded: "deny-all" }
  | {
      readonly kind: "allow-list";
      readonly recorded: Exclude<RecordedNetworkPolicy, string>;
      /** Whether `host`, a DNS name, is on the domain allow-list. */
      allowsDomain(host: string): boolean;
      /** Whether `address`, an IP literal, is in an allowed range. */
      allowsAddress(address: string): boolean;
      /** Whether `address` is in a denied range, which overrides every allow. */
      deniesAddress(address: string): boolean;
    };

const UNSUPPORTED =
  'bwrap sandbox supports the "allow-all" and "deny-all" network policies and allow-lists of ' +
  "domains and subnets";

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

  let domains: string[];
  if (policy.allow === undefined || Array.isArray(policy.allow)) {
    domains = stringList(policy.allow, "allow").map(normalizeDomain);
  } else if (isRecord(policy.allow)) {
    domains = Object.entries(policy.allow).map(([domain, rules]) => {
      if (!Array.isArray(rules) || rules.length > 0) {
        refuse(
          `rules on a domain (${JSON.stringify(domain)}) are not supported: header transforms and ` +
            "forwarding need the provider to terminate TLS",
        );
      }
      return normalizeDomain(domain);
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
  return {
    kind: "allow-list",
    recorded: {
      allow: uniqueDomains,
      ...(allowSubnets.length > 0 || denySubnets.length > 0
        ? {
            subnets: {
              ...(allowSubnets.length > 0 ? { allow: allowSubnets } : {}),
              ...(denySubnets.length > 0 ? { deny: denySubnets } : {}),
            },
          }
        : {}),
    },
    allowsDomain: (host) => {
      const name = host.toLowerCase().replace(/\.$/, "");
      return uniqueDomains.some((pattern) => matchesDomain(pattern, name));
    },
    allowsAddress: (address) => contains(allowed, address),
    deniesAddress: (address) => contains(denied, address),
  };
}
