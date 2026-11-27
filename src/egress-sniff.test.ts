import { describe, expect, test } from "vitest";
import {
  answerDnsQuery,
  DNS_NAME_ERROR,
  parseDnsQuestion,
  sniffServerName,
} from "./egress-sniff.js";
import { clientHello, dnsQuery } from "./provider.test-support.js";

describe("sniffServerName", () => {
  test("reads the server name of a TLS ClientHello", () => {
    expect(sniffServerName(clientHello("API.Example.com"))).toEqual({
      kind: "name",
      name: "api.example.com",
      protocol: "tls",
    });
  });

  test("waits for the rest of a ClientHello that arrived in pieces", () => {
    const hello = clientHello("api.example.com");
    for (const cut of [1, 5, 9, hello.length - 1]) {
      expect(sniffServerName(hello.subarray(0, cut))).toEqual({ kind: "more" });
    }
  });

  test("reads a ClientHello that spans two handshake records", () => {
    const hello = clientHello("api.example.com");
    const handshake = hello.subarray(5);
    const record = (fragment: Buffer) =>
      Buffer.concat([
        Buffer.from([0x16, 3, 1, fragment.length >> 8, fragment.length & 255]),
        fragment,
      ]);
    const split = Buffer.concat([
      record(handshake.subarray(0, 20)),
      record(handshake.subarray(20)),
    ]);
    expect(sniffServerName(split)).toMatchObject({ kind: "name", name: "api.example.com" });
    expect(sniffServerName(split.subarray(0, 25))).toEqual({ kind: "more" });
  });

  test("a handshake that names no domain, or names an address, has none", () => {
    expect(sniffServerName(clientHello(null))).toEqual({ kind: "none", protocol: "tls" });
    expect(sniffServerName(clientHello("10.0.0.1"))).toEqual({ kind: "none", protocol: "tls" });
    expect(sniffServerName(clientHello("bad name"))).toEqual({ kind: "none", protocol: "tls" });
  });

  test("a truncated or malformed ClientHello never reads past its end", () => {
    const hello = clientHello("api.example.com");
    // The record claims its full length, but the extension lengths lie.
    const lying = Buffer.from(hello);
    lying.writeUInt16BE(0xffff, lying.length - "api.example.com".length - 2);
    expect(sniffServerName(lying)).toEqual({ kind: "none", protocol: "tls" });
  });

  test("reads the Host header of an HTTP request, without its port", () => {
    const request = Buffer.from(
      "GET /x HTTP/1.1\r\nUser-Agent: t\r\nHost: Example.com:8080\r\n\r\n",
    );
    expect(sniffServerName(request)).toEqual({
      kind: "name",
      name: "example.com",
      protocol: "http",
    });
    expect(sniffServerName(request.subarray(0, 20))).toEqual({ kind: "more" });
  });

  test("an HTTP request without a usable Host names no domain", () => {
    expect(sniffServerName(Buffer.from("GET / HTTP/1.0\r\n\r\n"))).toEqual({
      kind: "none",
      protocol: "http",
    });
    expect(sniffServerName(Buffer.from("GET / HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n"))).toEqual({
      kind: "none",
      protocol: "http",
    });
    expect(sniffServerName(Buffer.from("GET / HTTP/1.1\r\nHost: [::1]:80\r\n\r\n"))).toEqual({
      kind: "none",
      protocol: "http",
    });
  });

  test("any other protocol names no domain", () => {
    expect(sniffServerName(Buffer.from("SSH-2.0-OpenSSH_9.6\r\n"))).toEqual({ kind: "none" });
    expect(sniffServerName(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))).toEqual({ kind: "none" });
    expect(sniffServerName(Buffer.alloc(0))).toEqual({ kind: "more" });
  });
});

describe("DNS questions", () => {
  test("reads the name a query asks about", () => {
    const query = dnsQuery("API.example.com");
    expect(parseDnsQuestion(query)).toEqual({ name: "api.example.com", end: query.length });
  });

  test("a response, a truncated query, or a compressed name is not a question", () => {
    const query = dnsQuery("example.com");
    const response = Buffer.from(query);
    response[2] = 0x81;
    expect(parseDnsQuestion(response)).toBeNull();
    expect(parseDnsQuestion(query.subarray(0, query.length - 3))).toBeNull();
    const compressed = Buffer.from(query);
    compressed[12] = 0xc0;
    expect(parseDnsQuestion(compressed)).toBeNull();
  });

  test("an empty answer echoes the question and drops everything after it", () => {
    const query = Buffer.concat([dnsQuery("example.com", 0xbeef), Buffer.from([1, 2, 3])]);
    const question = parseDnsQuestion(query)!;
    const answer = answerDnsQuery(query, question.end, DNS_NAME_ERROR);
    expect(answer.readUInt16BE(0)).toBe(0xbeef);
    expect(answer[2]! & 0x80).toBe(0x80);
    expect(answer[3]! & 0x0f).toBe(DNS_NAME_ERROR);
    expect(answer.length).toBe(question.end);
    expect(
      parseDnsQuestion(
        Buffer.concat([answer.subarray(0, 2), Buffer.from([1, 0]), answer.subarray(4)]),
      ),
    ).toEqual(question);
  });
});
