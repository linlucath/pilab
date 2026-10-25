import { cloneElement, Fragment, isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

function safeLink(value: string) {
  try { const parsed = new URL(value, window.location.origin); return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? value : undefined; }
  catch { return undefined; }
}
function highlightText(text: string, needle: string): ReactNode[] {
  if (!needle.trim()) return [text];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) => part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part);
}
function inline(text: string, highlight = ""): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(...highlightText(text.slice(cursor, start), highlight));
    const token = match[0];
    if (token.startsWith("**")) out.push(<strong key={index++}>{highlightText(token.slice(2, -2), highlight)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={index++}>{highlightText(token.slice(1, -1), highlight)}</code>);
    else {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = safeLink(parsed[2]);
      out.push(href ? <a key={index++} href={href} target="_blank" rel="noreferrer">{highlightText(parsed[1], highlight)}</a> : <span key={index++}>{highlightText(parsed[1], highlight)}</span>);
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) out.push(...highlightText(text.slice(cursor), highlight));
  return out.length ? out : [" "];
}
function cells(row: string) { return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()); }
function isPipeRow(row: string) { return /^\s*\|.*\|\s*$/.test(row); }
function isTableSeparator(row: string) { const columns = cells(row); return columns.length > 1 && columns.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))); }

function CodeBlock({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { setCopied(false); }
  }
  const language = source.split("\n", 1)[0].match(/^```([^\s`]*)/)?.[1] || "code";
  const code = source.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  return <div className="markdown-code"><div className="code-head"><span>{language}</span><button onClick={() => void copy()} aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制"}</button></div><pre><code>{code}</code></pre></div>;
}

export function Markdown({ content, highlight = "", trailing }: { content: string; highlight?: string; trailing?: ReactNode }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let index = 0;
  const flush = () => { if (paragraph.length) { blocks.push(<p key={`p-${index++}`}>{paragraph.map((line, i) => <Fragment key={i}>{i > 0 && <br />}{inline(line, highlight)}</Fragment>)}</p>); paragraph = []; } };
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush(); const code = [line]; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) code.push(lines[index++]);
      blocks.push(<CodeBlock key={`code-${index}`} source={code.join("\n")} />); continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { flush(); index++; continue; }
    if (isPipeRow(trimmed)) {
      let end = index + 1;
      while (end < lines.length && isPipeRow(lines[end])) end++;
      const rows = lines.slice(index, end).map((row) => row.trim());
      if (rows.length >= 2) {
        flush();
        const separator = rows.findIndex(isTableSeparator);
        const hasHeader = separator !== 0;
        const header = hasHeader ? cells(rows[0]) : undefined;
        const dataRows = separator >= 0
          ? rows.filter((_, rowIndex) => rowIndex !== separator && (!hasHeader || rowIndex !== 0)).map(cells)
          : rows.slice(1).map(cells);
        const columnCount = Math.max(header?.length || 0, ...dataRows.map((row) => row.length), 1);
        blocks.push(<div className="table-scroll" key={`table-${end}`}><table>{header && <thead><tr>{Array.from({ length: columnCount }, (_, column) => <th key={column}>{inline(header[column] || "", highlight)}</th>)}</tr></thead>}<tbody>{dataRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{inline(cell, highlight)}</td>)}</tr>)}</tbody></table></div>);
        index = end; continue;
      }
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) { flush(); const Tag = heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : heading[1].length === 3 ? "h3" : "h4"; blocks.push(<Tag key={`h-${index}`}>{inline(heading[2], highlight)}</Tag>); index++; continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); blocks.push(<hr key={`hr-${index++}`} />); continue; }
    const bullet = /^(?:[-*+]\s+)(.+)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) { flush(); const list: ReactNode[] = []; const ordered = !!numbered;
      while (index < lines.length) { const current = lines[index].trim(); const item = ordered ? /^\d+[.)]\s+(.+)$/.exec(current) : /^(?:[-*+]\s+)(.+)$/.exec(current); if (!item) break; list.push(<li key={index}>{inline(item[1], highlight)}</li>); index++; }
      blocks.push(ordered ? <ol key={`list-${index}`}>{list}</ol> : <ul key={`list-${index}`}>{list}</ul>); continue;
    }
    paragraph.push(trimmed); index++;
  }
  flush();
  if (trailing) {
    const last = blocks.at(-1);
    if (isValidElement<{ children?: ReactNode }>(last) && last.type === "p")
      blocks[blocks.length - 1] = cloneElement(last, {}, last.props.children, trailing);
    else blocks.push(<p className="markdown-streaming-tail" key="streaming-tail">{trailing}</p>);
  }
  return <div className="markdown-body">{blocks.length ? blocks : <span className="muted">空消息</span>}</div>;
}
