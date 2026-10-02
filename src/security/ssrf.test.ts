import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafePublicIp } from "./ssrf.js";

test("isSafePublicIp: blocks private, loopback, and metadata IPs", () => {
  assert.equal(isSafePublicIp("127.0.0.1"), false);
  assert.equal(isSafePublicIp("10.0.0.5"), false);
  assert.equal(isSafePublicIp("192.168.1.1"), false);
  assert.equal(isSafePublicIp("172.16.0.1"), false);
  assert.equal(isSafePublicIp("169.254.169.254"), false);
  assert.equal(isSafePublicIp("::1"), false);
});

test("isSafePublicIp: blocks IPv4-mapped IPv6 private targets", () => {
  assert.equal(isSafePublicIp("::ffff:127.0.0.1"), false);
  assert.equal(isSafePublicIp("::ffff:169.254.169.254"), false);
  assert.equal(isSafePublicIp("::ffff:7f00:1"), false);
});

test("isSafePublicIp: allows safe public IPs", () => {
  assert.equal(isSafePublicIp("8.8.8.8"), true);
  assert.equal(isSafePublicIp("1.1.1.1"), true);
  assert.equal(isSafePublicIp("104.16.132.229"), true);
  assert.equal(isSafePublicIp("::ffff:8.8.8.8"), true);
});
