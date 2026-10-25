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
