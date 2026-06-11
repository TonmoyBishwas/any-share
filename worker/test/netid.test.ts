// Run: node --test worker/test/netid.test.ts   (Node 24 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkId } from "../src/netid.ts";

test("IPv4 is used whole (NAT already collapses a LAN to one address)", () => {
  assert.equal(networkId("203.0.113.7"), "203.0.113.7");
});

test('the "local-dev" sentinel is unchanged', () => {
  assert.equal(networkId("local-dev"), "local-dev");
});

test("two IPv6 devices on the same /64 share one room id", () => {
  const full = networkId("2401:4900:1c00:abcd:1111:2222:3333:4444");
  const compressed = networkId("2401:4900:1c00:abcd::1"); // same LAN, compressed form
  assert.equal(full, compressed);
  assert.equal(full, "2401:4900:1c00:abcd::/64");
});

test("different /64 prefixes stay isolated", () => {
  assert.notEqual(
    networkId("2401:4900:1c00:abcd::1"),
    networkId("2401:4900:1c00:ef01::1"),
  );
});

test("compressed forms expand correctly (guards the naive-slice bug)", () => {
  assert.equal(networkId("fe80::1"), "fe80:0:0:0::/64");
  assert.equal(networkId("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(networkId("::1"), "0:0:0:0::/64");
});
