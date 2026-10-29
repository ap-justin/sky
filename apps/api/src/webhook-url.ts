import { BlockList, isIPv4, isIPv6 } from "node:net";

// addresses a subscriber URL may not name: loopback, unspecified, private, shared, link-local, unique-local
const internal = new BlockList();
internal.addSubnet("0.0.0.0", 8, "ipv4");
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("100.64.0.0", 10, "ipv4");
internal.addSubnet("127.0.0.0", 8, "ipv4");
internal.addSubnet("169.254.0.0", 16, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addAddress("::", "ipv6");
internal.addAddress("::1", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");

/**
 * Whether a subscriber URL's host is neither `localhost` nor a literal internal IP. Checks the WHATWG-parsed
 * host, which canonicalizes hex, octal and dword IPv4 spellings; BlockList matches an IPv4-mapped IPv6
 * address against the IPv4 ranges. A hostname that resolves to an internal address is not caught here.
 */
export function isAllowedWebhookUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (isIPv4(hostname)) return !internal.check(hostname, "ipv4");
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIPv6(bare)) return !internal.check(bare, "ipv6");
  return true;
}
