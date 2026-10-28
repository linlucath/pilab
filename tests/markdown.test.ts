import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

function render(content: string) {
  return renderToStaticMarkup(createElement(Markdown, { content }));
}

test("Markdown renders a pipe table whose first row is a separator", () => {
  const html = render("|---|---|\n| 1 | 封面 |\n| 2 | 章节 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<td>章节<\/td>/);
  assert.doesNotMatch(html, /\|---\|/);
});

test("Markdown keeps standard GFM table headers and accepts tables without separators", () => {
  const gfm = render("| 序号 | 标题 |\n| :--- | ---: |\n| 1 | 封面 |\n");
  assert.match(gfm, /<th>序号<\/th>/);
  assert.match(gfm, /<td>封面<\/td>/);
  const plain = render("| 序号 | 标题 |\n| 1 | 封面 |\n");
  assert.match(plain, /<th>序号<\/th>/);
  assert.match(plain, /<td>封面<\/td>/);
});

test("Markdown preserves the paragraph after a blank line", () => {
  const html = render("line1\n\nline2");
  assert.match(html, /<p>line1<\/p><p>line2<\/p>/);
});

test("Markdown preserves every paragraph across repeated blank lines", () => {
  const html = render("line1\n\n\nline2\n\nline3");
  assert.match(html, /<p>line1<\/p><p>line2<\/p><p>line3<\/p>/);
});

test("Markdown keeps the first list item after prose", () => {
  const html = render("Intro\n- Item 1\n- Item 2");
  assert.match(html, /<p>Intro<\/p><ul><li>Item 1<\/li><li>Item 2<\/li><\/ul>/);
});

test("Markdown keeps code and following prose after a paragraph", () => {
  const html = render("Intro\n```\nconst a = 1;\n```\nOutro");
  assert.match(html, /<code>const a = 1;<\/code>/);
  assert.match(html, /<p>Outro<\/p>/);
});

test("Markdown keeps prose after a heading or horizontal rule", () => {
  const heading = render("Intro\n## Heading\nBody");
  assert.match(heading, /<h2>Heading<\/h2><p>Body<\/p>/);
  const rule = render("Intro\n---\nBody");
  assert.match(rule, /<hr\/><p>Body<\/p>/);
});

test("Markdown keeps the body of an unclosed fence after prose", () => {
  const html = render("Intro\n```\nconst a = 1;");
  assert.match(html, /<code>const a = 1;<\/code>/);
});

test("Markdown escapes HTML-like text and preserves comparisons", () => {
  const html = render("<UserContext> <T> <div> x < y && y > z");
  assert.match(html, /&lt;UserContext&gt;/);
  assert.match(html, /&lt;T&gt;/);
  assert.match(html, /&lt;div&gt;/);
  assert.match(html, /x &lt; y &amp;&amp; y &gt; z/);
  assert.doesNotMatch(html, /<UserContext>|<T>|<div>/);
});

test("Markdown leaves unmatched inline markers as text and preserves line breaks", () => {
  const html = render("open **bold and `tick\nsecond line");
  assert.match(html, /open \*\*bold and `tick<br\/>second line/);
});
