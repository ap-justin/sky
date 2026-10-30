import { expect, test } from "vitest";
import { isAllowedWebhookUrl } from "./webhook-url.js";

test.each([
  ["localhost", "https://localhost/hook"],
  ["localhost with a port and odd case", "http://LocalHost:8080/hook"],
  ["localhost as an FQDN", "https://localhost./hook"],
  ["a localhost subdomain", "https://api.localhost/hook"],
  ["IPv4 loopback", "https://127.0.0.1/hook"],
  ["IPv4 loopback anywhere in 127/8", "https://127.8.9.10/hook"],
  ["IPv4 loopback in hex shorthand", "https://0x7f.1/hook"],
  ["IPv4 loopback as a dword", "https://2130706433/hook"],
  ["the unspecified IPv4 address", "https://0.0.0.0/hook"],
  ["10/8", "https://10.1.2.3/hook"],
  ["172.16/12, low end", "https://172.16.0.1/hook"],
  ["172.16/12, high end", "https://172.31.255.255/hook"],
  ["192.168/16", "https://192.168.1.1/hook"],
  ["100.64/10 (shared address space)", "https://100.64.0.1/hook"],
  ["link-local / cloud metadata", "http://169.254.169.254/latest/meta-data"],
  ["IPv6 loopback", "https://[::1]/hook"],
  ["the unspecified IPv6 address", "https://[::]/hook"],
  ["IPv6 link-local", "https://[fe80::1]/hook"],
  ["IPv6 unique-local fc00::/7, fc half", "https://[fc00::1]/hook"],
  ["IPv6 unique-local fc00::/7, fd half", "https://[fd12:3456::1]/hook"],
  ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/hook"],
  ["IPv4-mapped IPv6 private", "https://[::ffff:10.0.0.1]/hook"],
  ["an unparseable URL", "not a url"],
])("rejects %s", (_, url) => {
  expect(isAllowedWebhookUrl(url)).toBe(false);
});

test.each([
  ["a public hostname", "https://hooks.example.com/sky"],
  ["a public IPv4", "https://8.8.8.8/hook"],
  ["an address just outside 172.16/12", "https://172.32.0.1/hook"],
  ["an address just outside 100.64/10", "https://100.128.0.1/hook"],
  ["a public IPv6", "https://[2606:4700:4700::1111]/hook"],
  ["IPv4-mapped IPv6 public", "https://[::ffff:8.8.8.8]/hook"],
  [
    "a hostname that merely contains localhost",
    "https://localhost.example.com/hook",
  ],
])("allows %s", (_, url) => {
  expect(isAllowedWebhookUrl(url)).toBe(true);
});
