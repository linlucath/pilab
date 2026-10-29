import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

function render(content: string, options: { highlight?: string; trailing?: React.ReactNode } = {}) {
  return renderToStaticMarkup(createElement(Markdown, { content, ...options }));
}

test("Markdown renders GFM tables inside the existing horizontally scrollable dark-table wrapper", () => {
  const html = render("| 序号 | 标题 |\n| :--- | ---: |\n| 1 | 封面 |\n| 2 | 章节 |");
  assert.match(html, /<div class="table-scroll"><table>/);
  assert.match(html, /<th[^>]*>序号<\/th>/);
  assert.match(html, /<td style="text-align:right">封面<\/td>/);
  assert.match(html, /<td style="text-align:right">章节<\/td>/);
  assert.match(html, /text-align:left/);
});

test("Markdown renders blockquotes and nested ordered and unordered lists", () => {
  const html = render("> A quoted passage\n\n- Parent\n  - Nested child\n    - Third level\n\n1. First\n   1. Nested first\n2. Second");
  assert.match(html, /<blockquote>/);
  assert.match(html, /A quoted passage/);
  assert.equal((html.match(/<ul>/g) || []).length, 3);
  assert.equal((html.match(/<ol>/g) || []).length, 2);
  assert.match(html, /Parent/);
  assert.match(html, /Nested child/);
  assert.match(html, /Third level/);
  assert.match(html, /Nested first/);
});

test("Markdown renders inline and display LaTeX with KaTeX", () => {
  const html = render(`Inline math: $E = mc^2$\n\n$$\n\\frac{a}{b}\n$$`);
  assert.match(html, /class=\"katex\"/);
  assert.match(html, /class=\"katex-display\"/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /\$E = mc/);
});

test("Markdown requires the GFM delimiter row instead of treating arbitrary pipe text as a table", () => {
  const html = render("| 序号 | 标题 |\n| 1 | 封面 |");
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /序号/);
  assert.match(html, /封面/);
});

test("Markdown preserves paragraphs across blank lines and turns soft line breaks into breaks", () => {
  const html = render("line1\n\n\nline2\nline2b\n\nline3");
  assert.match(html, /<p>line1<\/p>\s*<p>line2<br\/>\s*line2b<\/p>\s*<p>line3<\/p>/);
});

test("Markdown keeps prose around lists and code blocks", () => {
  const list = render("Intro\n- Item 1\n- Item 2\n\nOutro");
  assert.match(list, /<p>Intro<\/p>\s*<ul>\s*<li>Item 1<\/li>\s*<li>Item 2<\/li>\s*<\/ul>\s*<p>Outro<\/p>/);

  const code = render("Intro\n```js\nconst a = 1;\n```\nOutro");
  assert.match(code, /<p>Intro<\/p>\s*<div class="markdown-code">/);
  assert.match(code, /<span>js<\/span>/);
  assert.match(code, /<pre><code>const a = 1;<\/code><\/pre>/);
  assert.match(code, /aria-label="复制代码"/);
  assert.match(code, /<p>Outro<\/p>/);
});

test("Markdown keeps code content after an unclosed fence", () => {
  const html = render("Intro\n```\nconst a = 1;");
  assert.match(html, /<pre><code>const a = 1;<\/code><\/pre>/);
});

test("Markdown keeps prose after a heading or horizontal rule", () => {
  const heading = render("Intro\n## Heading\nBody");
  assert.match(heading, /<h2>Heading<\/h2>\s*<p>Body<\/p>/);
  const setextHeading = render("Intro\n---\nBody");
  assert.match(setextHeading, /<h2>Intro<\/h2>/);
  const rule = render("Intro\n\n---\n\nBody");
  assert.match(rule, /<hr\/>\s*<p>Body<\/p>/);
});

test("Markdown escapes HTML-like text and preserves comparisons without rendering raw HTML", () => {
  const html = render("<UserContext> <T> <div> x < y && y > z <img src=x onerror=alert(1)>");
  assert.match(html, /&lt;UserContext&gt;/);
  assert.match(html, /&lt;T&gt;/);
  assert.match(html, /&lt;div&gt;/);
  assert.match(html, /x &lt; y &amp;&amp; y &gt; z/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<UserContext>|<T>|<div>|<img/);
});

test("Markdown only renders safe external links with isolation attributes", () => {
  const html = render("[web](https://example.com) [mail](mailto:test@example.com) [unsafe](javascript:alert(1)) [relative](/local)");
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">web<\/a>/);
  assert.match(html, /<a href="mailto:test@example.com" target="_blank" rel="noopener noreferrer">mail<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href="\/local"/);
  assert.match(html, /<span>unsafe<\/span>/);
  assert.match(html, /<span>relative<\/span>/);
});

test("Markdown preserves search highlighting in parsed inline content and table cells", () => {
  const html = render("**Needle** in [needle](https://example.com)\n\n| Header |\n| --- |\n| needle |", { highlight: "needle" });
  assert.match(html, /<strong><mark>Needle<\/mark><\/strong>/);
  assert.match(html, /<a[^>]*><mark>needle<\/mark><\/a>/);
  assert.match(html, /<td><mark>needle<\/mark><\/td>/);
});

test("Markdown keeps the streaming cursor inline at paragraph ends and after block content", () => {
  const trailing = createElement("span", { className: "streaming-cursor" });
  const paragraph = render("streaming text", { trailing });
  assert.match(paragraph, /<p>streaming text<span class="markdown-streaming-tail"><span class="streaming-cursor"><\/span><\/span><\/p>/);

  const code = render("```\nconst a = 1;\n```", { trailing });
  assert.match(code, /<p class="markdown-streaming-tail"><span class="streaming-cursor"><\/span><\/p>/);
});

test("Markdown displays an empty-state label for blank input", () => {
  assert.match(render(" \n\n "), /<span class="muted">空消息<\/span>/);
});
