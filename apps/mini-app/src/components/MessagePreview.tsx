/**
 * VaultLink Mini App — Telegram message bubble preview.
 *
 * Renders a 1:1 visual replica of how a broadcast lands in a real
 * Telegram chat: bot avatar + display name + message body (with
 * HTML or MarkdownV2 parsed to React nodes — never `dangerouslySetInnerHTML`)
 * + optional media placeholder + inline buttons styled like the real
 * Telegram client.
 *
 * The HTML/Markdown parsers are deliberately tiny — Telegram only supports
 * a handful of tags (b, strong, i, em, u, ins, s, strike, del, code, pre,
 * a) and a similarly small Markdown set. Anything outside the allowlist
 * is rendered as literal text rather than stripped, so the operator
 * spots their own typo in the preview instead of silently losing
 * formatting.
 *
 * Template variables (`{{first_name}}`, `{{username}}`, `{{user_id}}`,
 * `{{full_name}}`) are substituted with a sample user — by default the
 * caller passes their own profile so the preview reads like a real
 * incoming message.
 */

import type { JSX, ReactNode } from 'react';
import type {
  BroadcastButton,
  BroadcastParseMode,
} from '../types/api.js';

interface SampleUser {
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  telegram_user_id: string | number;
}

interface Props {
  text: string;
  parseMode: BroadcastParseMode | 'plain';
  buttons: BroadcastButton[][];
  mediaType?: '' | 'photo' | 'video' | 'document' | 'animation' | undefined;
  /** When non-empty, render a placeholder labelled with the media type. */
  hasMedia?: boolean | undefined;
  /** Bot identity displayed at the top of the bubble. */
  botName: string;
  botUsername?: string | undefined;
  /** Sample user used to substitute template variables. Falls back to
   * generic "Friend" placeholders when fields are blank. */
  sampleUser?: SampleUser | undefined;
  /** Translated label for the media placeholder ("Photo", "Video", ...). */
  mediaLabel?: string | undefined;
}

/* -------------------------------------------------------------------------- *
 * Template variable substitution
 * -------------------------------------------------------------------------- */

function substituteTemplates(text: string, user: SampleUser): string {
  const first = (user.first_name ?? '').trim();
  const last = (user.last_name ?? '').trim();
  const handle = (user.username ?? '').trim();
  const id = String(user.telegram_user_id ?? '');
  const full = [first, last].filter((s) => s.length > 0).join(' ').trim();
  return text
    .replace(/\{\{\s*first_name\s*\}\}/g, first || 'Friend')
    .replace(/\{\{\s*last_name\s*\}\}/g, last || '')
    .replace(/\{\{\s*full_name\s*\}\}/g, full || 'Friend')
    .replace(/\{\{\s*username\s*\}\}/g, handle ? `@${handle}` : 'friend')
    .replace(/\{\{\s*user_id\s*\}\}/g, id || '0');
}

/* -------------------------------------------------------------------------- *
 * Plain-text renderer — preserves newlines, escapes nothing.
 * -------------------------------------------------------------------------- */

function renderPlain(text: string): ReactNode {
  return text.split('\n').map((line, i, arr) => (
    <span key={i}>
      {line}
      {i < arr.length - 1 ? <br /> : null}
    </span>
  ));
}

/* -------------------------------------------------------------------------- *
 * HTML renderer — parses a SUBSET of the Telegram HTML allowlist.
 *
 * Supports:  <b>, <strong>, <i>, <em>, <u>, <ins>, <s>, <strike>, <del>,
 *            <code>, <pre>, <a href="...">, <br>
 *
 * Unknown tags pass through as literal text. This is intentional — the
 * operator should see "<foo>" in the preview if they typed it, instead
 * of guessing why their formatting "didn't work".
 *
 * The parser is tiny on purpose. It is NOT a general-purpose HTML
 * sanitizer — never feed user-submitted HTML through it without
 * upstream validation. For our use case the upstream validation is
 * Telegram itself: the operator types HTML that Telegram will then
 * render at send time.
 * -------------------------------------------------------------------------- */

const HTML_ALLOWLIST: Record<string, 'b' | 'i' | 'u' | 's' | 'code' | 'pre' | 'a'> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  ins: 'u',
  s: 's',
  strike: 's',
  del: 's',
  code: 'code',
  pre: 'pre',
  a: 'a',
};

interface ParsedNode {
  kind: 'text' | 'tag' | 'br';
  /** For tag nodes: the canonicalized tag name. */
  tag?: 'b' | 'i' | 'u' | 's' | 'code' | 'pre' | 'a';
  /** For tag nodes: parsed children. For text nodes: the literal value. */
  text?: string;
  href?: string;
  children?: ParsedNode[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseHtml(input: string): ParsedNode[] {
  // Tokenise the input as a flat list of (text|open-tag|close-tag|self-closing-br)
  // then build a tree by walking with a stack. Bail out gracefully on
  // mismatched tags by treating the unmatched close tag as literal text.
  const tokens: Array<
    | { type: 'text'; value: string }
    | { type: 'open'; tag: string; href?: string }
    | { type: 'close'; tag: string }
    | { type: 'br' }
  > = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ type: 'text', value: input.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', value: input.slice(i, lt) });
    const gt = input.indexOf('>', lt);
    if (gt === -1) {
      // Unterminated tag — render rest as text.
      tokens.push({ type: 'text', value: input.slice(lt) });
      break;
    }
    const raw = input.slice(lt + 1, gt).trim();
    if (raw.toLowerCase() === 'br' || raw.toLowerCase() === 'br/' || raw.toLowerCase() === 'br /') {
      tokens.push({ type: 'br' });
    } else if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().toLowerCase();
      tokens.push({ type: 'close', tag });
    } else {
      // Open tag — extract first word as tag, optional href="..." for <a>.
      const space = raw.indexOf(' ');
      const tag = (space === -1 ? raw : raw.slice(0, space)).toLowerCase();
      let href: string | undefined;
      if (space !== -1) {
        const m = raw.slice(space).match(/href\s*=\s*"([^"]*)"/i);
        if (m) href = m[1];
        else {
          const m2 = raw.slice(space).match(/href\s*=\s*'([^']*)'/i);
          if (m2) href = m2[1];
        }
      }
      const open: { type: 'open'; tag: string; href?: string } = { type: 'open', tag };
      if (href !== undefined) open.href = href;
      tokens.push(open);
    }
    i = gt + 1;
  }

  // Build tree from tokens.
  const root: ParsedNode = { kind: 'tag', tag: 'b', children: [] };
  // Sentinel root re-uses the tag shape but we only ever read its children.
  const stack: ParsedNode[] = [root];
  const top = (): ParsedNode => stack[stack.length - 1] ?? root;
  for (const tok of tokens) {
    if (tok.type === 'text') {
      top().children!.push({ kind: 'text', text: decodeEntities(tok.value) });
    } else if (tok.type === 'br') {
      top().children!.push({ kind: 'br' });
    } else if (tok.type === 'open') {
      const canonical = HTML_ALLOWLIST[tok.tag];
      if (!canonical) {
        // Not in allowlist — render as literal text.
        const literal = tok.href
          ? `<${tok.tag} href="${tok.href}">`
          : `<${tok.tag}>`;
        top().children!.push({ kind: 'text', text: literal });
        continue;
      }
      const node: ParsedNode = { kind: 'tag', tag: canonical, children: [] };
      if (canonical === 'a' && tok.href !== undefined) node.href = tok.href;
      top().children!.push(node);
      stack.push(node);
    } else if (tok.type === 'close') {
      const canonical = HTML_ALLOWLIST[tok.tag];
      // Walk back to the nearest matching open. If none, drop the close.
      let found = -1;
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]?.tag === canonical) {
          found = s;
          break;
        }
      }
      if (found === -1) {
        top().children!.push({ kind: 'text', text: `</${tok.tag}>` });
      } else {
        stack.length = found;
      }
    }
  }
  return root.children ?? [];
}

function renderParsed(nodes: ParsedNode[]): ReactNode {
  return nodes.map((n, i) => {
    if (n.kind === 'br') return <br key={i} />;
    if (n.kind === 'text') {
      const s = n.text ?? '';
      // Preserve literal newlines as <br> for plain text inside a tag.
      const parts = s.split('\n');
      return (
        <span key={i}>
          {parts.map((p, j) => (
            <span key={j}>
              {p}
              {j < parts.length - 1 ? <br /> : null}
            </span>
          ))}
        </span>
      );
    }
    // tag
    const inner = renderParsed(n.children ?? []);
    switch (n.tag) {
      case 'b':
        return <strong key={i}>{inner}</strong>;
      case 'i':
        return <em key={i}>{inner}</em>;
      case 'u':
        return <u key={i}>{inner}</u>;
      case 's':
        return <s key={i}>{inner}</s>;
      case 'code':
        return (
          <code
            key={i}
            className="rounded bg-tg-secondary-bg/80 px-1 py-0.5 font-mono text-[0.92em]"
          >
            {inner}
          </code>
        );
      case 'pre':
        return (
          <pre
            key={i}
            className="my-1 overflow-auto rounded-lg bg-tg-secondary-bg/80 p-2 font-mono text-[0.85em] text-tg-text"
          >
            {inner}
          </pre>
        );
      case 'a':
        return (
          <a
            key={i}
            href={n.href ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-tg-link underline"
          >
            {inner}
          </a>
        );
      default:
        return <span key={i}>{inner}</span>;
    }
  });
}

/* -------------------------------------------------------------------------- *
 * MarkdownV2 renderer — handles `*bold*`, `_italic_`, `__underline__`,
 * `~strike~`, `` `code` ``, ```pre```, and `[label](url)`. Telegram MD2
 * also requires escaping `*_~[]()` etc. — we treat `\X` as a literal X.
 * Anything else is plain text.
 * -------------------------------------------------------------------------- */

interface MdToken {
  type: 'text' | 'b' | 'i' | 'u' | 's' | 'code' | 'pre' | 'a' | 'br';
  value?: string;
  href?: string;
  children?: MdToken[];
}

function parseMd2(input: string): MdToken[] {
  const out: MdToken[] = [];
  let i = 0;
  let buf = '';
  const flushText = (): void => {
    if (buf.length > 0) {
      // Split on newlines so they render as <br>.
      const parts = buf.split('\n');
      parts.forEach((p, idx) => {
        if (p.length > 0) out.push({ type: 'text', value: p });
        if (idx < parts.length - 1) out.push({ type: 'br' });
      });
      buf = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];
    // Backslash escape
    if (ch === '\\' && i + 1 < input.length) {
      buf += input[i + 1];
      i += 2;
      continue;
    }
    // Code fence ```...```
    if (ch === '`' && input.slice(i, i + 3) === '```') {
      flushText();
      const end = input.indexOf('```', i + 3);
      if (end === -1) {
        buf += '```';
        i += 3;
        continue;
      }
      out.push({ type: 'pre', value: input.slice(i + 3, end) });
      i = end + 3;
      continue;
    }
    // Inline `code`
    if (ch === '`') {
      flushText();
      const end = input.indexOf('`', i + 1);
      if (end === -1) {
        buf += '`';
        i += 1;
        continue;
      }
      out.push({ type: 'code', value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    // Link: [label](url)
    if (ch === '[') {
      const closeBracket = input.indexOf(']', i + 1);
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        const closeParen = input.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText();
          out.push({
            type: 'a',
            value: input.slice(i + 1, closeBracket),
            href: input.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }
    // Underline __...__
    if (ch === '_' && input[i + 1] === '_') {
      const end = input.indexOf('__', i + 2);
      if (end !== -1) {
        flushText();
        out.push({ type: 'u', children: parseMd2(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // Italic _..._
    if (ch === '_') {
      const end = input.indexOf('_', i + 1);
      if (end !== -1) {
        flushText();
        out.push({ type: 'i', children: parseMd2(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    // Bold *...*
    if (ch === '*') {
      const end = input.indexOf('*', i + 1);
      if (end !== -1) {
        flushText();
        out.push({ type: 'b', children: parseMd2(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    // Strike ~...~
    if (ch === '~') {
      const end = input.indexOf('~', i + 1);
      if (end !== -1) {
        flushText();
        out.push({ type: 's', children: parseMd2(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flushText();
  return out;
}

function renderMd(nodes: MdToken[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <span key={i}>{n.value}</span>;
      case 'br':
        return <br key={i} />;
      case 'b':
        return <strong key={i}>{renderMd(n.children ?? [])}</strong>;
      case 'i':
        return <em key={i}>{renderMd(n.children ?? [])}</em>;
      case 'u':
        return <u key={i}>{renderMd(n.children ?? [])}</u>;
      case 's':
        return <s key={i}>{renderMd(n.children ?? [])}</s>;
      case 'code':
        return (
          <code
            key={i}
            className="rounded bg-tg-secondary-bg/80 px-1 py-0.5 font-mono text-[0.92em]"
          >
            {n.value}
          </code>
        );
      case 'pre':
        return (
          <pre
            key={i}
            className="my-1 overflow-auto rounded-lg bg-tg-secondary-bg/80 p-2 font-mono text-[0.85em] text-tg-text"
          >
            {n.value}
          </pre>
        );
      case 'a':
        return (
          <a
            key={i}
            href={n.href ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-tg-link underline"
          >
            {n.value}
          </a>
        );
      default:
        return null;
    }
  });
}

/* -------------------------------------------------------------------------- *
 * The bubble itself.
 * -------------------------------------------------------------------------- */

function MediaPlaceholder({
  type,
  label,
}: {
  type: NonNullable<Props['mediaType']>;
  label: string;
}): JSX.Element {
  const icon =
    type === 'photo' ? '🖼️' : type === 'video' ? '🎬' : type === 'animation' ? '🎞️' : '📎';
  return (
    <div className="-mx-2.5 -mt-2 mb-2 flex aspect-[16/10] items-center justify-center rounded-t-2xl bg-gradient-to-br from-brand-violet/30 via-brand-cyan/20 to-brand-pink/30 text-tg-subtitle-text">
      <div className="flex flex-col items-center gap-1">
        <span className="text-3xl">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
    </div>
  );
}

export function MessagePreview({
  text,
  parseMode,
  buttons,
  mediaType = '',
  hasMedia = false,
  botName,
  botUsername,
  sampleUser,
  mediaLabel = 'Media',
}: Props): JSX.Element {
  const user: SampleUser = sampleUser ?? {
    first_name: 'You',
    last_name: null,
    username: null,
    telegram_user_id: 0,
  };
  const substituted = substituteTemplates(text, user);

  let body: ReactNode;
  if (parseMode === 'HTML') {
    body = renderParsed(parseHtml(substituted));
  } else if (parseMode === 'MarkdownV2') {
    body = renderMd(parseMd2(substituted));
  } else {
    body = renderPlain(substituted);
  }

  const showMedia = hasMedia && mediaType !== '';
  const initials = (botName || '?').slice(0, 2).toUpperCase();

  return (
    <div className="rounded-2xl bg-gradient-to-br from-tg-secondary-bg/40 via-transparent to-tg-secondary-bg/20 p-3">
      <div className="flex items-end gap-2">
        {/* Bot avatar */}
        <div
          className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-brand-violet to-brand-fuchsia text-[11px] font-bold text-white shadow-soft"
          aria-hidden="true"
        >
          {initials}
        </div>

        {/* Bubble */}
        <div className="min-w-0 max-w-[85%] flex-1">
          <div className="overflow-hidden rounded-2xl rounded-bl-sm bg-tg-section-bg px-2.5 pb-2 pt-2 shadow-soft">
            {/* Bot identity */}
            <p className="text-[11px] font-semibold text-tg-link">
              {botName}
              {botUsername ? (
                <span className="ml-1 font-normal text-tg-hint">@{botUsername}</span>
              ) : null}
            </p>

            {showMedia ? (
              <MediaPlaceholder type={mediaType} label={mediaLabel} />
            ) : null}

            {/* Body */}
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-tg-text">
              {substituted.trim().length === 0 ? (
                <span className="italic text-tg-hint">…</span>
              ) : (
                body
              )}
            </div>

            {/* Inline buttons (Telegram style) */}
            {buttons.length > 0 ? (
              <div className="mt-2 space-y-1">
                {buttons.map((row, ri) => (
                  <div key={ri} className="flex gap-1">
                    {row.map((b, ci) => (
                      <a
                        key={ci}
                        href={b.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="press-scale flex-1 truncate rounded-lg bg-tg-button/15 px-2 py-1.5 text-center text-[11px] font-medium text-tg-link hover:bg-tg-button/25"
                      >
                        {b.text || '​'}
                        {b.url ? <span className="ml-1 text-tg-hint">↗</span> : null}
                      </a>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <p className="ml-2 mt-0.5 text-[9px] text-tg-hint">preview · live</p>
        </div>
      </div>
    </div>
  );
}
