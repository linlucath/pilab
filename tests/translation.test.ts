import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import test from "node:test";
import { createTranslationRouter, parseGoogleTranslation, TranslationService } from "../server/translation";

const googlePayload = (translated: string) => [[ [translated, "source", null, null, 1] ], null, "en"];

test("Google translation parser accepts Chrome and gtx response formats", () => {
  assert.equal(parseGoogleTranslation(["你好，世界"]), "你好，世界");
  assert.equal(parseGoogleTranslation([["你好", "en"]]), "你好");
  assert.equal(parseGoogleTranslation([[ ["你好", "Hello"], ["，世界", " world"] ], null, "en"]), "你好，世界");
  assert.equal(parseGoogleTranslation({ error: "bad response" }), null);
});

test("translation service prefers clients5 and reuses successful responses from cache", async () => {
  let calls = 0;
  let requestedUrl: URL | undefined;
  let requestedHeaders: Headers | undefined;
  const service = new TranslationService(async (input, init) => {
    calls++;
    requestedUrl = new URL(String(input));
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(["你好，世界"]), { status: 200 });
  });

  assert.equal(await service.translate("Hello, world!"), "你好，世界");
  assert.equal(await service.translate("Hello, world!"), "你好，世界");
  assert.equal(calls, 1);
  assert.equal(requestedUrl?.origin, "https://clients5.google.com");
  assert.equal(requestedUrl?.pathname, "/translate_a/t");
  assert.equal(requestedUrl?.searchParams.get("client"), "dict-chrome-ex");
  assert.equal(requestedUrl?.searchParams.get("sl"), "auto");
  assert.equal(requestedUrl?.searchParams.get("tl"), "zh-CN");
  assert.equal(requestedUrl?.searchParams.get("q"), "Hello, world!");
  assert.equal(requestedHeaders?.get("user-agent"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  assert.equal(requestedHeaders?.get("accept"), "*/*");
  assert.equal(requestedHeaders?.get("accept-language"), "en-US,en;q=0.9");
});

test("translation falls back from clients5 to translate.googleapis.com", async () => {
  const requestedUrls: URL[] = [];
  const service = new TranslationService(async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    if (url.hostname === "clients5.google.com") return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify(googlePayload("你好")), { status: 200 });
  });

  assert.equal(await service.translate("hello"), "你好");
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].hostname, "clients5.google.com");
  assert.equal(requestedUrls[0].searchParams.get("q"), "hello");
  assert.equal(requestedUrls[1].origin, "https://translate.googleapis.com");
  assert.equal(requestedUrls[1].pathname, "/translate_a/single");
  assert.equal(requestedUrls[1].searchParams.get("client"), "gtx");
});

test("translation failures fall back to source text and are not cached", async () => {
  let calls = 0;
  const service = new TranslationService(async () => {
    calls++;
    throw new Error("upstream unavailable");
  });
  assert.equal(await service.translate("Keep the original text."), "Keep the original text.");
  assert.equal(await service.translate("Keep the original text."), "Keep the original text.");
  assert.equal(calls, 4);
});

test("HTTP failures and upstream timeouts fall back to the original text", async () => {
  let failureCalls = 0;
  const rateLimited = new TranslationService(async () => {
    failureCalls++;
    return new Response("rate limited", { status: 429 });
  });
  assert.equal(await rateLimited.translate("Rate limits must not break reasoning."), "Rate limits must not break reasoning.");
  assert.equal(await rateLimited.translate("Rate limits must not break reasoning."), "Rate limits must not break reasoning.");
  assert.equal(failureCalls, 4);

  const timedOut = new TranslationService((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), 10);
  assert.equal(await timedOut.translate("Timeouts return the source text."), "Timeouts return the source text.");
});

test("translation service limits concurrent Google requests to three across text chunks", async () => {
  let active = 0;
  let maxActive = 0;
  const service = new TranslationService(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response(JSON.stringify(googlePayload("译")), { status: 200 });
  });

  const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    service.translate(`Paragraph ${index}. ${"word ".repeat(2_000)}`),
  ));
  assert.equal(results.length, 4);
  assert.equal(maxActive, 3);
});

test("translation service splits oversized Google queries without losing source order", async () => {
  const queries: string[] = [];
  const service = new TranslationService(async (input) => {
    queries.push(new URL(String(input)).searchParams.get("q") || "");
    return new Response(JSON.stringify(googlePayload("译")), { status: 200 });
  });
  const source = "word ".repeat(1_000);
  const translated = await service.translate(source);
  assert.ok(queries.length > 1);
  assert.ok(queries.every((query) => query.length <= 4_501));
  assert.equal(translated, "译".repeat(queries.length));
});

async function withTranslationApi<T>(run: (origin: string) => Promise<T>) {
  const app = express();
  app.use(express.json());
  app.use("/api/translate", createTranslationRouter({
    async translateMany(texts, targetLanguage) {
      return texts.map((text) => `${targetLanguage}:${text}`);
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("/api/translate accepts text and text batches with zh-CN as the default", async () => {
  await withTranslationApi(async (origin) => {
    const one = await fetch(`${origin}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hello" }) });
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { translations: ["zh-CN:Hello"] });

    const many = await fetch(`${origin}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: ["Good morning", "Good night"], targetLanguage: "ja" }) });
    assert.equal(many.status, 200);
    assert.deepEqual(await many.json(), { translations: ["ja:Good morning", "ja:Good night"] });
    assert.equal(many.headers.get("cache-control"), "no-store");
  });
});

test("/api/translate rejects malformed and oversized batches", async () => {
  await withTranslationApi(async (origin) => {
    const malformed = await fetch(`${origin}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: ["ok", 42] }) });
    assert.equal(malformed.status, 400);
    const badLanguage = await fetch(`${origin}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "ok", targetLanguage: "?" }) });
    assert.equal(badLanguage.status, 400);
    const tooLarge = await fetch(`${origin}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: ["x".repeat(20_001)] }) });
    assert.equal(tooLarge.status, 413);
  });
});
