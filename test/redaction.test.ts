import { test } from "node:test";
import assert from "node:assert/strict";
import { Span, SpanKind, StatusCode } from "../dist/otlp.js";
import { isSensitiveAttributeKey, redactUrl } from "../dist/redact.js";

test("URL redaction removes credentials, fragments, and every query value", () => {
  const value = redactUrl(
    "https://alice:password@example.test/orders?token=abc&unknown=customer-secret#raw",
    ["token"],
  );
  assert.equal(value.includes("alice"), false);
  assert.equal(value.includes("password"), false);
  assert.equal(value.includes("abc"), false);
  assert.equal(value.includes("customer-secret"), false);
  assert.equal(value.includes("raw"), false);
});

test("the span boundary drops bodies, headers, logs, exception content, and framework payloads", () => {
  const span = new Span({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "GET /users/:id",
    kind: SpanKind.SERVER,
    startUnixNano: 1n,
    endUnixNano: 2n,
  });
  span
    .setString("http.request.method", "GET")
    .setString("http.request.header.authorization", "Bearer abc.def.ghi")
    .setString("express.request.body", "password=hunter2")
    .setString("log.body", "alice@example.test")
    .setString("url.full", "https://example.test/?unknown=customer-secret")
    .setStatus(
      StatusCode.ERROR,
      "login failed for alice@example.test password=hunter2",
    );

  const json = JSON.stringify(span.toOtlp());
  assert.equal(json.includes("hunter2"), false);
  assert.equal(json.includes("alice@example.test"), false);
  assert.equal(json.includes("customer-secret"), false);
  assert.equal(json.includes("authorization"), false);
  assert.equal(span.toOtlp().status?.message, undefined);
  assert.equal(isSensitiveAttributeKey("nestjs.request.payload"), true);
  assert.equal(isSensitiveAttributeKey("restlytics.bindings_count"), false);
});
