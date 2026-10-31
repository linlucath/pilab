import express, { type Request, type Response } from "express";

const GOOGLE_CHROME_TRANSLATE_URL = "https://clients5.google.com/translate_a/t";
const GOOGLE_GTX_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const GOOGLE_REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};
const MAX_CONCURRENT_GOOGLE_REQUESTS = 3;
const MAX_BATCH_SIZE = 100;
const MAX_TEXT_LENGTH = 20_000;
const MAX_BATCH_CHARACTERS = 100_000;
const MAX_GOOGLE_QUERY_LENGTH = 4_500;

type TranslationFetcher = typeof fetch;

export function parseGoogleTranslation(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  if (payload.length > 0 && payload.every((part) => typeof part === "string")) {
    return (payload as string[]).join("") || null;
  }
  if (!Array.isArray(payload[0])) return null;

  const firstGroup = payload[0];
  if (typeof firstGroup[0] === "string") return firstGroup[0] || null;
  const segments = firstGroup.flatMap((segment: unknown) =>
    Array.isArray(segment) && typeof segment[0] === "string" ? [segment[0]] : [],
  );
  return segments.length ? segments.join("") : null;
}

function splitLongText(text: string, maxLength = MAX_GOOGLE_QUERY_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const minimumBoundary = Math.floor(maxLength * 0.65);
    const space = rest.lastIndexOf(" ", maxLength);
    const punctuation = Math.max(...[".?!;,:\n。？！；，、"].map((marks) => {
      let last = -1;
      for (const mark of marks) last = Math.max(last, rest.lastIndexOf(mark, maxLength));
      return last;
    }));
    let boundary = punctuation >= minimumBoundary ? punctuation + 1 : space >= minimumBoundary ? space : maxLength;
    if (boundary > 0 && boundary < rest.length && /[\uD800-\uDBFF]/.test(rest[boundary - 1]) && /[\uDC00-\uDFFF]/.test(rest[boundary])) boundary++;
    chunks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class TranslationService {
  private readonly cache = new Map<string, Promise<string>>();
  private activeGoogleRequests = 0;
  private readonly googleRequestQueue: Array<() => void> = [];

  constructor(
    private readonly fetcher: TranslationFetcher = fetch,
    private readonly timeoutMs = 5_000,
    private readonly cacheLimit = 500,
  ) {}

  async translate(text: string, targetLanguage = "zh-CN"): Promise<string> {
    if (!text.trim()) return text;
    const key = `${targetLanguage}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    let translation: Promise<string>;
    translation = this.translateUncached(text, targetLanguage)
      .then((result) => {
        if (result === null) {
          if (this.cache.get(key) === translation) this.cache.delete(key);
          return text;
        }
        if (this.cache.get(key) === translation) this.remember(key, Promise.resolve(result));
        return result;
      })
      .catch(() => {
        if (this.cache.get(key) === translation) this.cache.delete(key);
        return text;
      });
    this.remember(key, translation);
    return translation;
  }

  async translateMany(texts: string[], targetLanguage = "zh-CN"): Promise<string[]> {
    const translations = new Array<string>(texts.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const index = cursor++;
        translations[index] = await this.translate(texts[index], targetLanguage);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_GOOGLE_REQUESTS, texts.length) }, worker));
    return translations;
  }

  private async acquireGoogleRequestSlot() {
    if (this.activeGoogleRequests < MAX_CONCURRENT_GOOGLE_REQUESTS) {
      this.activeGoogleRequests++;
      return;
    }
    await new Promise<void>((resolve) => this.googleRequestQueue.push(resolve));
  }

  private releaseGoogleRequestSlot() {
    const next = this.googleRequestQueue.shift();
    if (next) next();
    else this.activeGoogleRequests--;
  }

  private remember(key: string, value: Promise<string>) {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async translateChunk(chunk: string, targetLanguage: string): Promise<string | null> {
    const chromeUrl = new URL(GOOGLE_CHROME_TRANSLATE_URL);
    chromeUrl.searchParams.set("client", "dict-chrome-ex");
    chromeUrl.searchParams.set("sl", "auto");
    chromeUrl.searchParams.set("tl", targetLanguage);
    chromeUrl.searchParams.set("q", chunk);

    const gtxUrl = new URL(GOOGLE_GTX_TRANSLATE_URL);
    gtxUrl.searchParams.set("client", "gtx");
    gtxUrl.searchParams.set("sl", "auto");
    gtxUrl.searchParams.set("tl", targetLanguage);
    gtxUrl.searchParams.set("dt", "t");
    gtxUrl.searchParams.set("q", chunk);

    await this.acquireGoogleRequestSlot();
    try {
      for (const url of [chromeUrl, gtxUrl]) {
        try {
          const response = await this.fetcher(url, {
            headers: GOOGLE_REQUEST_HEADERS,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          if (!response.ok) continue;
          const translation = parseGoogleTranslation(await response.json());
          if (translation !== null) return translation;
        } catch {
          // A failed primary endpoint should not prevent trying the fallback.
        }
      }
      return null;
    } finally {
      this.releaseGoogleRequestSlot();
    }
  }

  private async translateUncached(text: string, targetLanguage: string): Promise<string | null> {
    const chunks = splitLongText(text);
    const results = await Promise.all(chunks.map((chunk) => this.translateChunk(chunk, targetLanguage)));
    return results.some((result) => result === null) ? null : results.join("");
  }
}

export type TranslationProvider = Pick<TranslationService, "translateMany">;

export function createTranslationRouter(translate: TranslationProvider = new TranslationService()) {
  const router = express.Router();
  router.post("/", async (req: Request, res: Response) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    let texts: string[];
    if (Array.isArray(body.texts) && body.texts.every((text) => typeof text === "string")) {
      texts = body.texts as string[];
    } else if (typeof body.text === "string") {
      texts = [body.text];
    } else {
      res.status(400).json({ error: "texts 必须是字符串数组，或提供单个 text 字符串。" });
      return;
    }
    if (texts.length > MAX_BATCH_SIZE || texts.some((text) => text.length > MAX_TEXT_LENGTH) ||
        texts.reduce((total, text) => total + text.length, 0) > MAX_BATCH_CHARACTERS) {
      res.status(413).json({ error: "翻译内容过长，请分批提交。" });
      return;
    }
    const targetLanguage = body.targetLanguage === undefined ? "zh-CN" : body.targetLanguage;
    if (typeof targetLanguage !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(targetLanguage)) {
      res.status(400).json({ error: "targetLanguage 格式无效。" });
      return;
    }
    res.set("Cache-Control", "no-store");
    try {
      const translations = await translate.translateMany(texts, targetLanguage);
      res.json({ translations });
    } catch {
      res.json({ translations: texts });
    }
  });
  return router;
}
