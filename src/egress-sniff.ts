import { isIP } from "node:net";

/**
 * What the first bytes of a connection say about where it is going.
 * `more` means the answer needs bytes that have not arrived yet.
 */
export type Sniffed =
  | { readonly kind: "name"; readonly name: string; readonly protocol: "tls" | "http" }
  | { readonly kind: "none"; readonly protocol?: "tls" | "http" }
  | { readonly kind: "more" };

/** A ClientHello or a request head longer than this names no domain. */
export const MAX_SNIFF_BYTES = 16 * 1024;

const HOST_NAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/;

function hostName(value: string, protocol: "tls" | "http"): Sniffed {
  const name = value.toLowerCase().replace(/\.$/, "");
  if (name.length > 253 || !HOST_NAME.test(name) || isIP(name) !== 0) {
    return { kind: "none", protocol };
  }
  return { kind: "name", name, protocol };
}

/** The `server_name` extension of a ClientHello body, which starts at the client version. */
function clientHelloName(body: Buffer): Sniffed {
  const none: Sniffed = { kind: "none", protocol: "tls" };
  // Client version and random, then three length-prefixed fields.
  let at = 2 + 32;
  if (at + 1 > body.length) return none;
  at += 1 + body[at]!;
  if (at + 2 > body.length) return none;
  at += 2 + body.readUInt16BE(at);
  if (at + 1 > body.length) return none;
  at += 1 + body[at]!;
  if (at + 2 > body.length) return none;
  const end = Math.min(body.length, at + 2 + body.readUInt16BE(at));
  at += 2;
  while (at + 4 <= end) {
    const type = body.readUInt16BE(at);
    const size = body.readUInt16BE(at + 2);
    at += 4;
    if (at + size > end) return none;
    if (type === 0) {
      // A list of names, each a type byte and a length; type 0 is a host name.
      let entry = at + 2;
      while (entry + 3 <= at + size) {
        const length = body.readUInt16BE(entry + 1);
        if (entry + 3 + length > at + size) return none;
        if (body[entry] === 0) {
          return hostName(body.toString("latin1", entry + 3, entry + 3 + length), "tls");
        }
        entry += 3 + length;
      }
      return none;
    }
    at += size;
  }
  return none;
}

function sniffTls(data: Buffer): Sniffed {
  const none: Sniffed = { kind: "none", protocol: "tls" };
  const more: Sniffed = data.length < MAX_SNIFF_BYTES ? { kind: "more" } : none;
  // A ClientHello may span several handshake records; gather them.
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    if (data.length - at < 5) return more;
    if (data[at] !== 0x16 || data[at + 1] !== 0x03) return none;
    const length = data.readUInt16BE(at + 3);
    if (length === 0) return none;
    const fragment = data.subarray(at + 5, at + 5 + length);
    parts.push(fragment);
    const handshake = Buffer.concat(parts);
    if (handshake.length >= 4) {
      if (handshake[0] !== 0x01) return none;
      const need = 4 + handshake.readUIntBE(1, 3);
      if (need > MAX_SNIFF_BYTES) return none;
      if (handshake.length >= need) return clientHelloName(handshake.subarray(4, need));
    }
    if (fragment.length < length) return more;
    at += 5 + length;
  }
}

function sniffHttp(data: Buffer): Sniffed {
  const none: Sniffed = { kind: "none", protocol: "http" };
  const text = data.toString("latin1");
  const lineEnd = text.indexOf("\r\n");
  if (lineEnd === -1) return data.length < 2048 ? { kind: "more" } : { kind: "none" };
  if (!/^[A-Z]{1,16} \S+ HTTP\/1\.[01]$/.test(text.slice(0, lineEnd))) return { kind: "none" };
  const headersEnd = text.indexOf("\r\n\r\n");
  const head = headersEnd === -1 ? text : text.slice(0, headersEnd + 2);
  const host = /\r\nhost:[ \t]*([^\r\n]*)\r\n/i.exec(head);
  if (host === null) {
    return headersEnd === -1 && data.length < MAX_SNIFF_BYTES ? { kind: "more" } : none;
  }
  const value = host[1]!.trim();
  if (value.startsWith("[")) return none;
  return hostName(value.replace(/:\d{1,5}$/, ""), "http");
}

/**
 * Reads the domain a connection is for out of its first bytes: the server
 * name of a TLS ClientHello, or the `Host` header of an HTTP/1 request. Any
 * other protocol names no domain. Nothing is decrypted and nothing but the
 * name is kept.
 */
export function sniffServerName(data: Buffer): Sniffed {
  if (data.length === 0) return { kind: "more" };
  if (data[0] === 0x16) return sniffTls(data);
  if (data[0]! >= 0x41 && data[0]! <= 0x5a) return sniffHttp(data);
  return { kind: "none" };
}

/** The name a DNS query asks about, and where its question section ends. */
export function parseDnsQuestion(packet: Buffer): { name: string; end: number } | null {
  if (packet.length < 12) return null;
  // A response, or a query without a question, is not something to answer.
  if ((packet[2]! & 0x80) !== 0 || packet.readUInt16BE(4) < 1) return null;
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = packet[at];
    if (length === undefined) return null;
    at += 1;
    if (length === 0) break;
    // Names in a question are never compressed.
    if (length > 63 || at + length > packet.length) return null;
    labels.push(packet.toString("latin1", at, at + length));
    at += length;
  }
  if (at + 4 > packet.length) return null;
  return { name: labels.join(".").toLowerCase(), end: at + 4 };
}

export const DNS_NAME_ERROR = 3;
export const DNS_SERVER_FAILURE = 2;

/** An empty answer to `query` carrying `rcode`, with nothing but the question echoed. */
export function answerDnsQuery(query: Buffer, questionEnd: number, rcode: number): Buffer {
  const reply = Buffer.from(query.subarray(0, questionEnd));
  // Response; the query's opcode and recursion-desired bit are kept.
  reply[2] = (reply[2]! & 0x79) | 0x80;
  // Recursion available, and the result.
  reply[3] = 0x80 | rcode;
  reply.writeUInt16BE(1, 4);
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  return reply;
}
