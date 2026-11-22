// A fast drop-in for makefun-site 1.0.0, written from the behaviour stated in
// its README and the semantics its code shows. run(input) returns the same
// output tree makefun-site's build returns for the same input, byte for byte:
// every page, index, tag page, build-report.txt and static file.
//
// The implementation is deliberately flat and allocation-light: line scanners
// instead of regular expressions on the hot paths, inline rendering over string
// ranges instead of slicing, templates compiled once into small instruction
// arrays and rendered straight into one shared output array, and per-build
// caches for slugs, long dates and cards. It reads no clock, no environment,
// no randomness and no file: the answer is a function of the input alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isDigit = (c) => c >= 48 && c <= 57;
const isSpaceTab = (c) => c === 32 || c === 9;

/** JavaScript whitespace, as /\s/ sees it, by code unit. */
function isSpace(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// ---------------------------------------------------------------- HTML escaping

/** Append `s` to `out` with & < > " ' escaped. */
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escInto(out, s) {
  ESC_RE.lastIndex = 0;
  let m;
  let start = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index > start) out.push(s.slice(start, m.index));
    out.push(ESC_MAP[m[0]]);
    start = m.index + 1;
  }
  if (start === 0) out.push(s);
  else if (start < s.length) out.push(s.slice(start));
}

/** `s` escaped, as a string. */
function escStr(s) {
  const out = [];
  escInto(out, s);
  return out.join('');
}

// ---------------------------------------------------------------- slugs and dates

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** A slugger with a per-build cache (tag names and titles repeat). */
function makeSlugger() {
  const cache = new Map();
  function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let plain = text;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) >= 128) { ascii = false; break; }
    }
    // Pure ASCII is unchanged by NFKD and holds no combining marks.
    if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    if (ascii) {
      for (let i = 0; i < plain.length; i++) {
        const c = plain.charCodeAt(i);
        let keep = -1;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === -1) {
          if (out.length > 0) gap = true;
          continue;
        }
        if (gap) { out += '-'; gap = false; }
        out += String.fromCharCode(keep);
      }
    } else {
      for (const ch of plain) {
        const c = ch.codePointAt(0);
        let keep = -1;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === -1) {
          if (out.length > 0) gap = true;
          continue;
        }
        if (gap) { out += '-'; gap = false; }
        out += String.fromCharCode(keep);
      }
    }
    if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  }
  return slugify;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A long-date formatter with a per-build cache. */
function makeLongDate() {
  const cache = new Map();
  return (date) => {
    let hit = cache.get(date);
    if (hit === undefined) {
      hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
      cache.set(date, hit);
    }
    return hit;
  };
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` holds only spaces and tabs. */
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs stripped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare value. */
function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function dateVal(raw) {
  let bad = raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45;
  if (!bad) {
    for (let i = 0; i < 10 && !bad; i++) {
      if (i === 4 || i === 7) continue;
      if (!isDigit(raw.charCodeAt(i))) bad = true;
    }
  }
  const y = bad ? 0 : (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = bad ? 0 : (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = bad ? 0 : (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  if (bad || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

function tagsVal(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',').map((t) => t.trim());
  for (const t of tags) {
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
  }
  return { value: tags };
}

function layoutVal(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
  }
  return raw.length === 0 ? { error: 'key "layout": not a template name' } : { value: raw };
}

function slugVal(raw) {
  if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else if (c === 45 && !prevDash) prevDash = true;
    else return { error: 'key "slug": not a slug' };
  }
  return prevDash ? { error: 'key "slug": not a slug' } : { value: raw };
}

/** One key's value, or why it is refused. */
function keyVal(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringVal(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateVal(raw);
    case 'tags':
      return tagsVal(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return layoutVal(raw);
    case 'slug':
      return slugVal(raw);
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Only the front matter itself is split into
 * lines; the body is sliced out untouched.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line is a line that is exactly "---": find it by scanning
  // for "\n---" followed by a newline or the end of the text.
  let closeAt = -1;
  let bodyAt = -1;
  let from = 3; // the "\n" ending the opening line may precede the closing one
  for (;;) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = idx;
      bodyAt = after === text.length ? text.length : after + 1;
      break;
    }
    from = idx + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmLines = text.slice(4, closeAt).split('\n');
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (blankLine(line) || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and _, a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) {
      raw = line.slice(k + 2);
      let e = raw.length;
      while (e > 0 && isSpaceTab(raw.charCodeAt(e - 1))) e--;
      raw = raw.slice(0, e);
    } else return { error: `line ${j + 2} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyVal(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes, as a table by code unit. */
const ESCAPABLE_TBL = new Array(128).fill(false);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_TBL[ch.charCodeAt(0)] = true;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A fence-open line's language, or null when the line is no fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && isSpaceTab(line.charCodeAt(j))) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let j = 3;
  while (j < line.length && isSpaceTab(line.charCodeAt(j))) j++;
  return j === line.length;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let j = h;
  while (j < line.length && isSpaceTab(line.charCodeAt(j))) j++;
  let e = line.length;
  while (e > j && isSpaceTab(line.charCodeAt(e - 1))) e--;
  if (e === j) return null;
  return { depth: h, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  let j = 3;
  while (j < line.length && isSpaceTab(line.charCodeAt(j))) j++;
  return j === line.length;
}

/** A bullet item's text, or null when the line opens no bullet list. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null when the line opens no ordered list. */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && isDigit(line.charCodeAt(j))) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !/\s/.test(line[j]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return blankLine(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE_TBL[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE_TBL[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * The first index from `from` where `s` holds a character inline rendering
 * treats specially (`\`, backtick, `*` or `[`), or `end` when there is none.
 * One C++ scan per character kind beats a per-character JavaScript loop over
 * long runs of plain text.
 */
function nextSpecial(s, from, end) {
  let best = end;
  let j = s.indexOf('\\', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('`', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('*', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('[', from);
  if (j !== -1 && j < best) best = j;
  return best;
}

/**
 * `s[start..end)` rendered inline into `out`; `env.link(target)` is a link's href.
 * Works over a range so strong, emphasis and link bodies never need slicing.
 */
function inlineInto(out, s, start, end, env) {
  let i = start;
  while (i < end) {
    const nx = nextSpecial(s, i, end);
    if (nx > i) {
      escInto(out, s.slice(i, nx));
      i = nx;
    }
    if (i >= end) break;
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < end && ESCAPABLE_TBL[s.charCodeAt(i + 1)]) {
      out.push(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        out.push('<code>');
        escInto(out, s.slice(i + 1, j));
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineInto(out, s, i + 2, j, env);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j !== -1 && j > i + 1) {
        out.push('<em>');
        inlineInto(out, s, i + 1, j, env);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, end);
      let m = -1;
      if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= end) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (m !== -1 && target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        escInto(out, env.link(target));
        out.push('">');
        inlineInto(out, s, i + 1, k, env);
        out.push('</a>');
        i = m + 1;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    // A backslash before a character it does not escape, or any other
    // character nextSpecial returned: itself, escaped.
    escInto(out, s[i]);
    i++;
  }
}

/** `s` rendered inline, as a string. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(out, s, 0, s.length, env);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // One dispatch on the first character: a line starting with a space or
    // tab is blank or a paragraph, and every other block kind announces
    // itself by that character alone.
    if (c0 === 32 || c0 === 9) {
      if (blankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        out.push('<pre><code');
        if (lang !== '') {
          out.push(' class="language-');
          out.push(lang);
          out.push('"');
        }
        out.push('>');
        while (i < n && !fenceClose(lines[i])) {
          escInto(out, lines[i]);
          out.push('\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inlineStr(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        i = renderList(out, lines, i, n, false, 1, b, env);
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') parts.push(l);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const joined = parts.join('\n');
        inlineInto(out, joined, 0, joined.length, env);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        i = renderList(out, lines, i, n, true, o.num, o.text, env);
        continue;
      }
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const text = parts.join('\n');
    const html = inlineStr(text, env);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/** One list block, rendered into `out` from `lines[i]`; returns the next index. */
function renderList(out, lines, i, n, isOrdered, start, firstText, env) {
  const items = [[trimLine(firstText)]];
  i++;
  while (i < n) {
    const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
    if (m !== null) {
      items.push([trimLine(isOrdered ? m.text : m)]);
      i++;
    } else if (isContinued(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n');
  for (const item of items) {
    out.push('<li>');
    const joined = item.join('\n');
    inlineInto(out, joined, 0, joined.length, env);
    out.push('</li>\n');
  }
  out.push(isOrdered ? '</ol>\n' : '</ul>\n');
  return i;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpacesTabs(src, a, b) {
  for (let j = a; j < b; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src`'s tokens: ['text', str], ['var'|'raw', path] and ['tag', str]. A {% %}
 * tag alone on its line takes the whole line with it, its newline included.
 */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push(['text', text]);
      text = '';
      tokens.push([raw ? 'raw' : 'var', pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push(['text', text]);
    text = '';
    tokens.push(['tag', src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push(['text', text]);
  return tokens;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). Nodes are small arrays with a numeric kind: 0 text [0, str],
 * 1 var [1, path], 2 raw [2, path], 3 if [3, not, path, then, else|null],
 * 4 for [4, name, path, body], 5 include [5, name].
 */
function parseTemplate(name, src) {
  const root = [6, []];
  const stack = [root];
  let body = root[1];
  for (const tok of tokenize(name, src)) {
    if (tok[0] === 'text') body.push([0, tok[1]]);
    else if (tok[0] === 'var' || tok[0] === 'raw') body.push([tok[0] === 'var' ? 1 : 2, tok[1]]);
    else {
      const tag = tok[1];
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if (tag === 'else') {
        if (top[0] !== 3 || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top[4] = [];
        body = top[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent[0] === 6 ? parent[1] : parent[0] === 4 ? parent[3] : parent[4] ?? parent[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1][0] === 4 ? 'for' : 'if'} is not closed`);
  return root[1];
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }) into `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1: {
        // Escaped value: strings need the escape table, numbers and
        // booleans never do, arrays are joined first.
        const v = lookup(scope, n[1]);
        if (typeof v === 'string') escInto(out, v);
        else if (typeof v === 'number') out.push(String(v));
        else if (v === true) out.push('true');
        else if (v === false) out.push('false');
        else if (Array.isArray(v)) escInto(out, textOf(v));
        break;
      }
      case 2: {
        const v = lookup(scope, n[1]);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 3: {
        const v = truthy(lookup(scope, n[2]));
        const branch = v !== n[1] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n[2]);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n[3], { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    } else if (c < 0xa0) {
      if (!inWord) { inWord = true; n++; }
    } else if (isSpace(c)) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugger();
  const longDate = makeLongDate();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in order: refused, the generator's own directory, a post
  // with no date, a layout that is no template, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = ['tags', 'page'].find((d) => s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? ['posts', 'tags', 'page'] : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and links as templates read them (each card built once).
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates };
  // One root scope reused by every render: its page/posts/pager/tag slots are
  // assigned (or cleared to undefined, which reads the same as absent) per
  // render, and renders run one after another, so nothing is retained.
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const out = [];
    renderNodes(nodes, rootScope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
