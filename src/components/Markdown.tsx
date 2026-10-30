import { Children, cloneElement, isValidElement, memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { Check, Copy } from "lucide-react";

const safeProtocols = new Set(["http:", "https:", "mailto:"]);

function safeLink(value?: string) {
  if (!value) return undefined;
  try {
    return safeProtocols.has(new URL(value).protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function highlightChildren(children: ReactNode, needle: string): ReactNode {
  const query = needle.trim();
  if (!query) return children;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(${escaped})`, "gi");
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return child.split(matcher).map((part, index) =>
        part.toLocaleLowerCase() === query.toLocaleLowerCase()
          ? <mark key={index}>{part}</mark>
          : part,
      );
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      if (child.type === "mark" || child.props.children === undefined) return child;
      return cloneElement(child as ReactElement<{ children?: ReactNode }>, {
        children: highlightChildren(child.props.children, query),
      });
    }
    return child;
  });
}

function appendStreamingTail(): ReturnType<Plugin<[], Root>> {
  return (tree) => {
    const lastBlock = tree.children.at(-1);
    const isInline = lastBlock?.type === "paragraph";
    const tail = {
      type: "streamingTail",
      data: {
        hName: isInline ? "span" : "p",
        hProperties: { className: [isInline ? "markdown-streaming-tail-inline" : "markdown-streaming-tail"] },
      },
    };

    if (isInline && lastBlock.type === "paragraph") lastBlock.children.push(tail as never);
    else tree.children.push(tail as never);
  };
}

function CodeBlock({ source, language }: { source: string; language: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return <div className="markdown-code">
    <div className="code-head">
      <span>{language}</span>
      <button onClick={() => void copy()} aria-label="复制代码">
        {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制"}
      </button>
    </div>
    <pre><code>{source}</code></pre>
  </div>;
}

function renderCodeBlock(children: ReactNode) {
  const code = Children.toArray(children).find((child) => isValidElement(child));
  if (!isValidElement<{ children?: ReactNode; className?: string }>(code)) return <pre>{children}</pre>;

  const className = code.props.className || "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] || "code";
  const source = String(code.props.children ?? "").replace(/\n$/, "");
  return <CodeBlock source={source} language={language} />;
}

export const Markdown = memo(function Markdown({ content, highlight = "", trailing }: { content: string; highlight?: string; trailing?: ReactNode }) {
  const hasTrailing = trailing !== undefined && trailing !== null && trailing !== false;
  const components = useMemo<Components>(() => ({
    a({ href, title, children }) {
      const safeHref = safeLink(href);
      const highlighted = highlightChildren(children, highlight);
      return safeHref
        ? <a href={safeHref} title={title} target="_blank" rel="noopener noreferrer">{highlighted}</a>
        : <span>{highlighted}</span>;
    },
    code({ children, className, node: _node, ...props }) {
      return <code {...props} className={className}>{highlightChildren(children, highlight)}</code>;
    },
    pre({ children }) {
      return renderCodeBlock(children);
    },
    p({ children, className, node: _node, ...props }) {
      if (className === "markdown-streaming-tail")
        return <p className="markdown-streaming-tail">{trailing}</p>;
      return <p {...props} className={className}>{highlightChildren(children, highlight)}</p>;
    },
    span({ children, className, node: _node, ...props }) {
      if (className === "markdown-streaming-tail-inline")
        return <span className="markdown-streaming-tail">{trailing}</span>;
      return <span {...props} className={className}>{highlightChildren(children, highlight)}</span>;
    },
    h1: ({ children, node: _node, ...props }) => <h1 {...props}>{highlightChildren(children, highlight)}</h1>,
    h2: ({ children, node: _node, ...props }) => <h2 {...props}>{highlightChildren(children, highlight)}</h2>,
    h3: ({ children, node: _node, ...props }) => <h3 {...props}>{highlightChildren(children, highlight)}</h3>,
    h4: ({ children, node: _node, ...props }) => <h4 {...props}>{highlightChildren(children, highlight)}</h4>,
    h5: ({ children, node: _node, ...props }) => <h5 {...props}>{highlightChildren(children, highlight)}</h5>,
    h6: ({ children, node: _node, ...props }) => <h6 {...props}>{highlightChildren(children, highlight)}</h6>,
    li: ({ children, node: _node, ...props }) => <li {...props}>{highlightChildren(children, highlight)}</li>,
    th: ({ children, node: _node, ...props }) => <th {...props}>{highlightChildren(children, highlight)}</th>,
    td: ({ children, node: _node, ...props }) => <td {...props}>{highlightChildren(children, highlight)}</td>,
    table: ({ children, node: _node, ...props }) =>
      <div className="table-scroll"><table {...props}>{children}</table></div>,
  }), [highlight, trailing]);

  if (!content.trim()) return <div className="markdown-body"><span className="muted">空消息</span></div>;

  return <div className="markdown-body">
    <ReactMarkdown
      components={components}
      remarkPlugins={hasTrailing
        ? [remarkGfm, remarkBreaks, remarkMath, appendStreamingTail]
        : [remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={(url) => safeLink(url) ?? ""}
    >
      {content}
    </ReactMarkdown>
  </div>;
}, (previous, next) => previous.content === next.content && previous.highlight === next.highlight && previous.trailing === next.trailing);
