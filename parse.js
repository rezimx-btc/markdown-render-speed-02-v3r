// A fast CommonMark + GFM renderer that matches marked 18.1.3's output
// exactly (same HTML, code unit for code unit). Written from scratch in
// this session: dependency-free ES module, exports parse(markdown).
//
// Layout of the file:
//   1. small utilities (escaping, entities, label folding, URL cleaning)
//   2. line handling with tab-aware column math
//   3. link reference definition parsing
//   4. the block parser (containers + leaf blocks, relative indents)
//   5. the block renderer
//   6. the inline parser (delimiter stack, links, GFM autolinks)
//   7. parse()

// ---------------------------------------------------------------- utilities
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const WS = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c) => c >= '0' && c <= '9';
const isAlphaNum = (c) =>
  (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// Escape &, <, >, " and ' for HTML text and attribute values. marked
// escapes all five in text content.
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') rep = '&amp;';
    else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode one entity reference starting at s[i] (s[i] === '&').
// Named references (&name;) are passed through verbatim by marked, so
// they return the raw slice. Numeric references decode to a code point;
// 0 and surrogates become U+FFFD, values above 0x10FFFF are invalid
// (null: the caller then escapes the '&' literally).
// Returns [decodedString, consumedLength, isNamed] or null.
function entityAt(s, i) {
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') {
      hex = true;
      j++;
    }
    const start = j;
    while (j < s.length) {
      const c = s[j];
      if (hex ? (isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) : isDigit(c)) j++;
      else break;
    }
    if (j === start || s[j] !== ';') return null;
    const num = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (num === 0 || (num >= 0xd800 && num <= 0xdfff)) return ['\uFFFD', j + 1 - i, false];
    if (num > 0x10ffff) return null;
    return [String.fromCodePoint(num), j + 1 - i, false];
  }
  let j = i + 1;
  if (j < s.length && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) {
    j++;
    while (j < s.length && isAlphaNum(s[j])) j++;
    if (s[j] === ';') return [s.slice(i, j + 1), j + 1 - i, true];
  }
  return null;
}

// Process backslash escapes: a backslash before an ASCII punctuation
// character is dropped (the punctuation is kept); a backslash before
// anything else is kept literally.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Decode entities inside a link destination / title. Named references
// are left alone (they are kept verbatim on output); numeric references
// decode to their character.
function decodeInUrl(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const e = entityAt(s, i);
      if (e !== null) {
        out += e[0];
        i += e[1];
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

// Normalise a link label: trim, collapse whitespace runs to one space,
// full case fold (lowercase plus the multi-char folds the spec needs).
function normLabel(s) {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/\ufb05/g, 'st')
    .replace(/\ufb06/g, 'st');
}

// Percent-encode a URL the way encodeURI does (spaces, quotes, brackets,
// backslashes, non-ASCII), after dropping ASCII control characters.
// Entities are left alone; the attribute escaper keeps them verbatim.
function encodeUrl(u) {
  let t = '';
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    t += u[i];
  }
  try {
    // encodeURI would turn a bare '%' into '%25', but marked keeps
    // '%' literal in every position (oracle: '/x%y', '/x%zz', '98%-'
    // all stay as-is). Encode each '%'-separated part and rejoin.
    return t.split('%').map(encodeURI).join('%');
  } catch (e) {
    return t;
  }
}

// Clean a link destination the way marked does: process backslash
// escapes, then percent-encode.
function cleanDest(href) {
  return encodeUrl(unescapeBackslashes(href));
}

// Clean an autolink URL: percent-encode only (backslashes in an autolink
// are literal characters, not escapes).
function cleanAutolinkUrl(url) {
  return encodeUrl(url);
}

// Clean a link title: process backslash escapes and decode entities.
// No percent-encoding (the attribute escaper handles the rest).
function cleanTitle(title) {
  return unescapeBackslashes(decodeInUrl(title));
}

// ------------------------------------------------------- line handling
// A document is split into lines (no terminators kept). All column math
// is tab aware: a tab advances to the next multiple of 4. When a prefix
// of N columns is consumed and the boundary falls inside a tab, the tab
// is replaced by the spaces that remain — this is what makes a tab in a
// fenced code block inside a list item expand, while a tab after the
// indent of an indented code block stays a literal tab.

// Columns of leading spaces/tabs of line, and the index where the
// non-whitespace starts.
function leadCols(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  return [col, i];
}

// True when the line holds only spaces/tabs.
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Expand the leading tabs of s to spaces, given that s starts at
// column startCol. Tabs in the content (past the leading whitespace)
// are left alone.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') {
      col++;
      out += ' ';
      i++;
    } else if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  return out + s.slice(i);
}

// Consume n columns from the start of line (tab aware). Returns the
// remaining string, or null when the line runs out before n columns.
// A tab straddling the boundary becomes spaces, and the leading tabs
// that follow it are expanded from their original columns (a tab's
// width depends on its column in the original line, so it must not be
// re-measured from the stripped string).
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  while (col < n && i < line.length) {
    const c = line[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      const next = col + (4 - (col % 4));
      if (next <= n) {
        col = next;
        i++;
      } else {
        return ' '.repeat(next - n) + expandLeadingTabs(line.slice(i + 1), next);
      }
    } else return null;
  }
  if (col < n) return null;
  return line.slice(i);
}

// Consume a blockquote prefix: up to 3 spaces, '>', then one optional
// space or tab. Returns the remaining string, or null when the line is
// not a blockquote line. A blank line matches every container, so the
// caller handles blanks before calling this. A tab after '>' is
// consumed as one column; the rest of it becomes spaces.
function stripQuote(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ' && spaces < 3) {
    i++;
    spaces++;
  }
  if (i >= line.length || line[i] !== '>') return null;
  i++;
  const colAfter = spaces + 1;
  if (i < line.length && line[i] === ' ') i++;
  else if (i < line.length && line[i] === '\t') {
    const next = colAfter + (4 - (colAfter % 4));
    return ' '.repeat(next - (colAfter + 1)) + expandLeadingTabs(line.slice(i + 1), next);
  }
  return line.slice(i);
}

// ------------------------------------------------- link reference defs
// Parse a link destination starting at text[j] (after '(' or after the
// label colon). Returns { dest, end } where end is the index just past
// the destination, or null.
function parseDest(text, j) {
  const n = text.length;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  if (text[j] === '<') {
    let k = j + 1;
    while (k < n && text[k] !== '>' && text[k] !== '\n' && text[k] !== '<') {
      if (text[k] === '\\' && k + 1 < n && PUNCT.has(text[k + 1])) k += 2;
      else k++;
    }
    if (k >= n || text[k] !== '>') return null;
    return { dest: text.slice(j + 1, k), end: k + 1 };
  }
  // Bare destination: no spaces or control chars, parens balanced.
  let k = j;
  let depth = 0;
  while (k < n) {
    const c = text[k];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
    if (c === '\\' && k + 1 < n && PUNCT.has(text[k + 1])) {
      k += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      k++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      k++;
      continue;
    }
    k++;
  }
  if (k === j) return null;
  return { dest: text.slice(j, k), end: k };
}

// Parse a link title starting at text[j]. Returns { title, end } or null.
function parseTitle(text, j) {
  const n = text.length;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  const q = text[j];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let k = j + 1;
  let depth = 0;
  while (k < n) {
    const c = text[k];
    if (c === '\\' && k + 1 < n && PUNCT.has(text[k + 1])) {
      k += 2;
      continue;
    }
    if (q === '(' && c === '(') {
      depth++;
      k++;
      continue;
    }
    if (c === close) {
      if (q === '(' && depth > 0) {
        depth--;
        k++;
        continue;
      }
      return { title: text.slice(j + 1, k), end: k + 1 };
    }
    k++;
  }
  return null;
}

// Find the end of a link label starting at text[j] === '['. Labels may
// contain balanced brackets (any depth) and backtick spans. A ']' inside
// a code span, an autolink, or an inline HTML tag does not close the
// label. Returns the index of the closing ']' or -1.
function findLabelEnd(text, j) {
  const n = text.length;
  let depth = 0;
  let k = j + 1;
  let tickRun = 0;
  while (k < n) {
    const c = text[k];
    if (c === '`') {
      let m = k;
      while (m < n && text[m] === '`') m++;
      const run = m - k;
      if (tickRun > 0) {
        // Inside a code span: only a run of the same length closes it;
        // a shorter or longer run is literal content.
        if (run === tickRun) tickRun = 0;
      } else {
        tickRun = run;
      }
      k = m;
      continue;
    }
    if (tickRun > 0) {
      k++;
      continue;
    }
    if (c === '<') {
      // Skip an autolink or an inline HTML tag: a ']' inside one does
      // not close the label.
      let m = AUTOLINK_SCHEME_RE.exec(text.slice(k));
      if (m) {
        k += m[0].length;
        continue;
      }
      m = AUTOLINK_EMAIL_RE.exec(text.slice(k));
      if (m) {
        k += m[0].length;
        continue;
      }
      m = HTML_TAG_RE.exec(text.slice(k));
      if (m) {
        k += m[0].length;
        continue;
      }
      k++;
      continue;
    }
    if (c === '\\' && k + 1 < n) {
      k += 2;
      continue;
    }
    if (c === '[') {
      depth++;
      k++;
      continue;
    }
    if (c === ']') {
      if (depth === 0) return k;
      depth--;
      k++;
      continue;
    }
    k++;
  }
  return -1;
}

// Try to parse one link reference definition at text[pos] (which must be
// at a line start, allowing up to 3 leading spaces). On success returns
// { label, dest, title, end } where end is just past the definition
// (before the line ending that follows it).
function parseDefAt(text, pos) {
  const n = text.length;
  let i = pos;
  let sp = 0;
  while (i < n && text[i] === ' ' && sp < 3) {
    i++;
    sp++;
  }
  if (i >= n || text[i] !== '[') return null;
  const close = findLabelEnd(text, i);
  if (close < 0) return null;
  const rawLabel = text.slice(i + 1, close);
  // A definition label may not contain an unescaped '[' or ']'.
  for (let q = 0; q < rawLabel.length; q++) {
    if (rawLabel[q] === '\\' && q + 1 < rawLabel.length) {
      q++;
      continue;
    }
    if (rawLabel[q] === '[' || rawLabel[q] === ']') return null;
  }
  const label = normLabel(rawLabel);
  if (label === '') return null;
  let j = close + 1;
  if (j >= n || text[j] !== ':') return null;
  j++;
  const d = parseDest(text, j);
  if (d === null) return null;
  j = d.end;
  // Optional title on this line or a following line. A title must be
  // separated from the destination by whitespace.
  let title = null;
  let k = j;
  let sawWS = false;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) {
    k++;
    sawWS = true;
  }
  if (k < n && text[k] === '\n') {
    // Title may sit on the next line, alone, at any indent.
    let m = k + 1;
    while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
    if (m < n && (text[m] === '"' || text[m] === "'" || text[m] === '(')) {
      const t = parseTitle(text, m);
      if (t !== null) {
        // The title line must end the definition.
        let e = t.end;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= n || text[e] === '\n') {
          title = t.title;
          j = t.end;
          k = j;
          while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
          sawWS = true;
        }
      }
    }
  } else if (sawWS && k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const t = parseTitle(text, k);
    if (t !== null) {
      title = t.title;
      j = t.end;
      k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
    }
  }
  if (k < n && text[k] !== '\n') return null;
  return { label, dest: d.dest, title, end: k };
}

// Extract leading link reference definitions from a paragraph's text
// (lines joined with '\n'). Registers them in defs (first one wins) and
// returns the remaining paragraph text ('' when the paragraph was only
// definitions). Definitions must start at a line beginning.
function extractDefs(text, defs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const d = parseDefAt(text, pos);
    if (d === null) break;
    if (!(d.label in defs)) {
      defs[d.label] = { dest: d.dest, title: d.title };
    }
    pos = d.end;
    if (pos < n && text[pos] === '\n') pos++;
    // Skip blank lines between definitions? No: a blank line ends the run.
    if (pos < n && text[pos] === '\n') break;
  }
  return text.slice(pos);
}

// ------------------------------------------------------- block helpers
const BLOCK_TAG = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Is the line a thematic break? 3+ of the same * - _ with spaces/tabs.
function isHr(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return false;
  const c = line[i];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (; i < line.length; i++) {
    if (line[i] === c) count++;
    else if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return count >= 3;
}

// Match the start of an HTML block (types 1-7) on a line whose indent is
// at most 3. Returns { type, endTag } where endTag is the string whose
// presence on a line ends the block (null for blank-line endings), or
// null when the line does not start an HTML block. Type 7 (a complete
// tag) is returned with type 7.
function matchHtmlStart(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length || line[i] !== '<') return null;
  const rest = line.slice(i);
  let m;
  if ((m = /^<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(rest))) {
    return { type: 1, endTag: '</' + m[1].toLowerCase() };
  }
  if (rest.startsWith('<!--')) return { type: 2, endTag: '-->' };
  if (rest.startsWith('<?')) return { type: 3, endTag: '?>' };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, endTag: '>' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, endTag: ']]>' };
  if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest))) {
    if (BLOCK_TAG.has(m[1].toLowerCase())) return { type: 6, endTag: null };
  }
  // Type 7: a complete open or close tag on a line by itself. A closing
  // tag may not carry attributes.
  m = /^(<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.exec(rest);
  if (m) return { type: 7, endTag: null };
  return null;
}

// Does this line end the given HTML block? For types 1-5 the end string
// must appear on the line (case-insensitive for type 1).
function htmlLineEnds(h, line) {
  if (h.endTag === null) return false;
  if (h.kind === 1) return line.toLowerCase().indexOf(h.endTag) >= 0;
  return line.indexOf(h.endTag) >= 0;
}

// Match a list marker at the start of a line. Returns null, or
// { ordered, bullet, start, contentIndent, content, empty }.
// contentIndent is measured in columns from the line start (the caller
// passes the line after outer containers were stripped, so it is
// relative to the container, which is what cm-259/cm-260 need).
function matchListStart(line) {
  const [leadCol, leadIdx] = leadCols(line);
  if (leadCol > 3) return null;
  let i = leadIdx;
  if (i >= line.length) return null;
  let ordered = false;
  let bullet = null;
  let start = 0;
  let markerLen = 0;
  const c = line[i];
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    markerLen = 1;
    i++;
  } else if (isDigit(c)) {
    let j = i;
    while (j < line.length && isDigit(line[j]) && j - i < 9) j++;
    if (j - i > 9 || j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    start = parseInt(line.slice(i, j), 10);
    ordered = true;
    bullet = line[j];
    markerLen = j - i + 1;
    i = j + 1;
  } else return null;
  // The marker must be followed by a space, a tab, or end of line.
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  const markerEndCol = leadCol + markerLen;
  if (i >= line.length) {
    return { ordered, bullet, start, contentIndent: markerEndCol + 1, content: '', empty: true };
  }
  // Count the whitespace columns after the marker.
  let col = markerEndCol;
  let k = i;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  const sp = col - markerEndCol;
  if (k >= line.length) {
    return { ordered, bullet, start, contentIndent: markerEndCol + 1, content: '', empty: true };
  }
  if (sp >= 1 && sp <= 4) {
    return { ordered, bullet, start, contentIndent: col, content: line.slice(k), empty: false };
  }
  // 5+ spaces of whitespace: the content indent is marker + 1, and the
  // rest of the whitespace stays as content (tab aware).
  const rest = stripCols(line.slice(i), 1);
  return { ordered, bullet, start, contentIndent: markerEndCol + 1, content: rest === null ? '' : rest, empty: false };
}

// Split a table row line into cells on unescaped | outside code spans.
// A leading/trailing | drops the empty edge cell. \| outside a code span
// becomes a literal |; inside a code span it is kept as \|.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  let tick = 0;
  while (i < n) {
    const c = line[i];
    if (c === '`') {
      let m = i;
      while (m < n && line[m] === '`') m++;
      if (tick === 0) tick = m - i;
      else if (m - i === tick) tick = 0;
      cur += line.slice(i, m);
      i = m;
      continue;
    }
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') {
      // An escaped pipe is a literal pipe, inside a code span too.
      cur += '|';
      i += 2;
      continue;
    }
    if (tick === 0 && c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  // Drop an empty edge cell when the line starts/ends with |.
  let start = 0;
  let end = cells.length;
  if (cells.length > 0 && line.trimStart().startsWith('|') && cells[0].trim() === '') start = 1;
  if (end > start && line.trimEnd().endsWith('|') && cells[end - 1].trim() === '') end--;
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// Is this line a table delimiter row? Every cell may hold only -, : and
// spaces, with at least one -. Returns the alignments or null.
function tableDelim(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell;
    if (!/^-+$/.test(t) && !/^:-+$/.test(t) && !/^-+:$/.test(t) && !/^:-+:$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':') && t.length >= 3) aligns.push('center');
    else if (t.endsWith(':')) aligns.push('right');
    else if (t.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// ------------------------------------------------------- block parser
// Strip up to n columns from the start of line (tab aware). Unlike
// stripCols, a line with fewer than n columns of whitespace is fine:
// the remainder is whatever follows the whitespace that is there.
function stripUpTo(line, n) {
  let col = 0;
  let i = 0;
  while (col < n && i < line.length) {
    const c = line[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      const next = col + (4 - (col % 4));
      if (next <= n) {
        col = next;
        i++;
      } else {
        return ' '.repeat(next - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

// Match an ATX heading: up to 3 spaces, 1-6 #, then space/tab/EOL.
// Returns { level, text } or null.
function matchAtx(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  let hashes = 0;
  while (i + hashes < line.length && line[i + hashes] === '#') hashes++;
  if (hashes < 1 || hashes > 6) return null;
  const after = i + hashes;
  if (after < line.length && line[after] !== ' ' && line[after] !== '\t') return null;
  let text = line.slice(after).trim();
  // A closing sequence of #s preceded by a space/tab, or content that
  // is only #s (the space after the opening hashes counts as the
  // separator), is stripped.
  if (/^#+$/.test(text)) text = '';
  else {
    const m = /^(.*?)[ \t]+#+[ \t]*$/.exec(text);
    if (m) text = m[1].trimEnd();
  }
  return { level: hashes, text };
}

// Match a fenced code start: up to 3 spaces, 3+ backticks or tildes.
// Returns { ch, len, indent, info } or null (a backtick fence whose info
// holds a backtick is not a fence).
function matchFence(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len++;
  if (len < 3) return null;
  const info = line.slice(i + len).trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len, indent: i, info };
}

// Is this line the closing fence for f? Same char, length >= opening,
// indent at most 3, nothing but spaces after.
function isClosingFence(line, f) {
  const [cols, idx] = leadCols(line);
  if (cols > 3) return false;
  let len = 0;
  while (idx + len < line.length && line[idx + len] === f.ch) len++;
  if (len < f.len) return false;
  for (let k = idx + len; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

// Match a setext heading underline: up to 3 spaces, =+ or -+, then only
// spaces. Returns 1 or 2, or 0.
function matchSetext(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return 0;
  const c = line[i];
  if (c !== '=' && c !== '-') return 0;
  let j = i;
  while (j < line.length && line[j] === c) j++;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return 0;
  }
  return c === '=' ? 1 : 2;
}

// Parse the blocks of src into a tree. defs collects link reference
// definitions (first one wins). Returns the root node.
function parseBlocks(src, defs) {
  const norm = src.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  if (norm.endsWith('\n')) lines.pop();
  const root = { t: 'root', children: [] };
  const open = [root];
  const top = () => open[open.length - 1];

  function finalize(b) {
    if (b.t === 'para') {
      const text = b.lines.join('\n');
      b.text = extractDefs(text, defs);
      b.lines = null;
      if (b.text === '') b.dead = true;
    } else if (b.t === 'icode') {
      while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
    }
  }
  function closeTo(idx) {
    while (open.length > idx) finalize(open.pop());
  }
  // Mark the deepest open list item as having seen a blank line between
  // blocks (drives loose/tight).
  function markBlank() {
    for (let k = open.length - 1; k >= 1; k--) {
      if (open[k].t === 'item') {
        open[k]._blank = true;
        break;
      }
    }
  }
  // A new block is about to start inside an item that saw a blank line
  // after already holding a block: the list goes loose.
  function noteBlockStart(item) {
    if (item && item._blank && item.children.length > 0) {
      const list = item._list;
      if (list) list.loose = true;
    }
    if (item) item._blank = false;
  }
  // The parent container a new block belongs to, and the item it sits in.
  function curItem() {
    for (let k = open.length - 1; k >= 1; k--) {
      if (open[k].t === 'item') return open[k];
    }
    return null;
  }

  // Create a new block from cur (already container-stripped) under the
  // current top container. Loops for blockquotes and list items.
  function newBlock(cur) {
    // A list only continues for a list item of the same list; any other
    // block closes the list first (this is what lets a thematic break
    // end a list). A line that is both a list item and a thematic
    // break ('* * *') is a break, not an item (cm-060).
    if (top().t === 'list') {
      const lm0 = matchListStart(cur);
      const lst = top();
      if (lm0 === null || lm0.ordered !== lst.ordered || lm0.bullet !== lst.bullet || isHr(cur)) {
        closeTo(open.length - 1);
      }
    }
    let parent = top();
    for (;;) {
      // ATX heading
      const atx = matchAtx(cur);
      if (atx) {
        noteBlockStart(curItem());
        parent.children.push({ t: 'heading', level: atx.level, text: atx.text });
        return;
      }
      // Fenced code
      const fe = matchFence(cur);
      if (fe) {
        noteBlockStart(curItem());
        const lang = unescapeBackslashes(fe.info.split(/[ \t]/, 1)[0]);
        const node = { t: 'fence', ch: fe.ch, len: fe.len, indent: fe.indent, lang, lines: [] };
        parent.children.push(node);
        open.push(node);
        return;
      }
      // Thematic break
      if (isHr(cur)) {
        noteBlockStart(curItem());
        parent.children.push({ t: 'hr' });
        return;
      }
      // HTML block (types 1-7; no paragraph is open here)
      const hs = matchHtmlStart(cur);
      if (hs) {
        noteBlockStart(curItem());
        const node = { t: 'html', kind: hs.type, endTag: hs.endTag, lines: [cur] };
        parent.children.push(node);
        if (hs.type <= 5 && htmlLineEnds(node, cur)) {
          // ends on its first line
        } else {
          open.push(node);
        }
        return;
      }
      // Blockquote
      const q = stripQuote(cur);
      if (q !== null) {
        const node = { t: 'quote', children: [] };
        parent.children.push(node);
        open.push(node);
        parent = node;
        cur = q;
        continue;
      }
      // List
      const lm = matchListStart(cur);
      if (lm) {
        let list = null;
        if (parent.t === 'list' && parent.ordered === lm.ordered && parent.bullet === lm.bullet) {
          list = parent;
          // A blank line before this item makes the list loose.
          const prev = list.items[list.items.length - 1];
          if (prev && prev._blank) list.loose = true;
        } else {
          list = { t: 'list', ordered: lm.ordered, bullet: lm.bullet, start: lm.start, items: [], loose: false, children: [] };
          parent.children.push(list);
          open.push(list);
        }
        noteBlockStart(curItem());
        const item = { t: 'item', children: [], contentIndent: lm.contentIndent, task: null, _list: list, _blank: false };
        list.items.push(item);
        list.children.push(item);
        open.push(item);
        let content = lm.content;
        if (!lm.empty) {
          const tm = /^\[( |x|X)\](?:[ \t]+|$)/.exec(content);
          if (tm) {
            item.task = tm[1] === ' ' ? false : true;
            content = content.slice(tm[0].length);
          }
        }
        parent = item;
        cur = content;
        if (cur === '' || isBlankLine(cur)) return;
        continue;
      }
      // Indented code
      const [ic] = leadCols(cur);
      if (ic >= 4) {
        noteBlockStart(curItem());
        const node = { t: 'icode', lines: [stripCols(cur, 4)] };
        parent.children.push(node);
        open.push(node);
        return;
      }
      // Paragraph: the line's leading indentation is not content.
      noteBlockStart(curItem());
      const node = { t: 'para', lines: [cur] };
      parent.children.push(node);
      open.push(node);
      return;
    }
  }

  for (let li = 0; li < lines.length; li++) {
    let rem = lines[li];
    let failIdx = -1;
    let blank = false;
    let j = 1;
    for (; j < open.length; j++) {
      const f = open[j];
      if (f.t === 'quote') {
        if (isBlankLine(rem)) {
          // A blank line carries no '>' prefix, so the quote ends here.
          failIdx = j;
          break;
        }
        const r = stripQuote(rem);
        if (r === null) {
          failIdx = j;
          break;
        }
        rem = r;
      } else if (f.t === 'list') {
        // a list adds no prefix of its own
      } else if (f.t === 'item') {
        if (isBlankLine(rem)) {
          blank = true;
          break;
        }
        const r = stripCols(rem, f.contentIndent);
        if (r === null) {
          failIdx = j;
          break;
        }
        rem = r;
      } else {
        break; // a leaf block: containers above it all matched
      }
    }
    // A line that became blank after its container prefixes were
    // stripped (e.g. a lone '>') is a blank line inside those containers.
    if (failIdx < 0 && !blank && isBlankLine(rem)) blank = true;
    if (failIdx >= 0) {
      // Lazy continuation: when the deepest open leaf is a paragraph and
      // the line does not start a block that can interrupt it, the line
      // continues that paragraph inside the containers that did match,
      // even though a container prefix is missing (CommonMark §5.1).
      // A blank line is never a lazy continuation.
      const leaf = top();
      let lazy = false;
      if (leaf.t === 'para' && !isBlankLine(rem)) {
        let interrupts = false;
        if (matchAtx(rem) !== null || matchFence(rem) !== null) interrupts = true;
        else if (isHr(rem)) interrupts = true;
        else if (matchHtmlStart(rem) !== null && matchHtmlStart(rem).type <= 6) interrupts = true;
        else if (stripQuote(rem) !== null) interrupts = true;
        else {
          const lm = matchListStart(rem);
          if (lm !== null && !lm.empty && (!lm.ordered || lm.start === 1)) interrupts = true;
        }
        lazy = !interrupts;
      }
      if (!lazy) closeTo(failIdx);
    }
    if (blank || isBlankLine(rem)) {
      const t = top();
      if (t.t === 'fence') {
        // A blank line inside a fence keeps its spaces (minus the fence
        // indent); a truly empty line contributes ''.
        t.lines.push(stripUpTo(rem, t.indent));
      } else if (t.t === 'icode') {
        // A blank line inside indented code keeps the spaces past the
        // 4-column indent.
        const stripped = stripCols(rem, 4);
        t.lines.push(stripped === null ? '' : stripped);
      } else if (t.t === 'html' && t.kind <= 5) {
        t.lines.push('');
      } else {
        if (t.t === 'para' || t.t === 'html' || t.t === 'table') closeTo(open.length - 1);
        markBlank();
      }
      continue;
    }
    const t = top();
    if (t.t === 'fence') {
      if (isClosingFence(rem, t)) {
        closeTo(open.length - 1);
      } else {
        t.lines.push(stripUpTo(rem, t.indent));
      }
      continue;
    }
    if (t.t === 'icode') {
      const [ic] = leadCols(rem);
      if (ic >= 4) {
        t.lines.push(stripCols(rem, 4));
        continue;
      }
      closeTo(open.length - 1);
      newBlock(rem);
      continue;
    }
    if (t.t === 'html') {
      t.lines.push(rem);
      if (t.kind <= 5 && htmlLineEnds(t, rem)) closeTo(open.length - 1);
      continue;
    }
    if (t.t === 'table') {
      // A line that starts a new block (blockquote, heading, fence,
      // thematic break, list) ends the table (gfm-201); a plain row
      // line is appended as a table row.
      if (stripQuote(rem) !== null || matchAtx(rem) !== null || matchFence(rem) !== null || isHr(rem)) {
        closeTo(open.length - 1);
        newBlock(rem);
        continue;
      }
      const lmT = matchListStart(rem);
      if (lmT !== null && !lmT.empty) {
        closeTo(open.length - 1);
        newBlock(rem);
        continue;
      }
      t.rows.push(rem);
      continue;
    }
    if (t.t === 'para') {
      // Table delimiter? (needs | or :; a bare --- is a setext underline)
      // The header row's cell count must equal the delimiter's column
      // count, or it is not a table at all (gfm-203).
      const aligns = tableDelim(rem);
      if (aligns !== null && (rem.indexOf('|') >= 0 || rem.indexOf(':') >= 0) && splitTableRow(t.lines[t.lines.length - 1]).length === aligns.length) {
        const parent = open[open.length - 2];
        const idx = parent.children.indexOf(t);
        const table = { t: 'table', header: [t.lines[t.lines.length - 1]], aligns, rows: [] };
        if (t.lines.length > 1) {
          const head = { t: 'para', lines: t.lines.slice(0, -1) };
          finalize(head);
          if (!head.dead) parent.children.splice(idx, 1, head, table);
          else parent.children.splice(idx, 1, table);
        } else {
          parent.children.splice(idx, 1, table);
        }
        open.pop();
        open.push(table);
        continue;
      }
      const sx = matchSetext(rem);
      if (sx !== 0) {
        const parent = open[open.length - 2];
        const idx = parent.children.indexOf(t);
        const text = t.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        const rest = extractDefs(text, defs);
        const node = { t: 'heading', level: sx, text: rest };
        if (rest === '') node.dead = true;
        parent.children.splice(idx, 1, node);
        open.pop();
        continue;
      }
      if (isHr(rem)) {
        closeTo(open.length - 1);
        newBlock(rem);
        continue;
      }
      // Blocks that can interrupt a paragraph.
      let interrupts = false;
      if (matchAtx(rem) !== null || matchFence(rem) !== null) interrupts = true;
      else if (matchHtmlStart(rem) !== null && matchHtmlStart(rem).type <= 6) interrupts = true;
      else if (stripQuote(rem) !== null) interrupts = true;
      else {
        const lm = matchListStart(rem);
        if (lm !== null && !lm.empty && (!lm.ordered || lm.start === 1)) interrupts = true;
      }
      if (interrupts) {
        closeTo(open.length - 1);
        newBlock(rem);
        continue;
      }
      // A paragraph continuation line keeps its leading whitespace
      // (oracle: 'foo\n     bar' keeps the 5 spaces). Only a hard break
      // strips the next line's leading whitespace, and that is handled
      // by the inline parser.
      t.lines.push(rem);
      continue;
    }
    newBlock(rem);
  }
  closeTo(1);
  return root;
}

// ------------------------------------------------------- inline parser
// Document-level inline state, shared across every paragraph of the
// document (this is marked behaviour, not a bug): an unclosed <a> tag
// suppresses every later GFM autolink until a </a> appears.
function newInlineState() {
  return { inLink: false, inRawBlock: false };
}

const WS_RE = /\s/u;
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isWSChar(ch) {
  return ch === undefined || WS_RE.test(ch);
}
function isPunctChar(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}

// Flanking for a delimiter run: prev is the char before the run, next
// the char after it. Returns [canOpen, canClose] for * and _ rules are
// applied by the caller.
function flanking(prev, next) {
  const prevWS = isWSChar(prev);
  const nextWS = isWSChar(next);
  const prevP = isPunctChar(prev);
  const nextP = isPunctChar(next);
  const left = !nextWS && (!nextP || prevWS || prevP);
  const right = !prevWS && (!prevP || nextWS || nextP);
  return [left, right];
}

const WWW_RE = /^www\.(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const SCHEME_RE = /^(?:https?|ftp):\/\/(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const AUTOLINK_SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/;
const HTML_TAG_RE = /^(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)/;
const TAG_NAME_RE = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

// Trim a GFM autolink the way marked's backpedal does: drop trailing
// punctuation, drop an unbalanced ), drop a trailing &word; entity whole.
function trimUrl(u) {
  let end = u.length;
  for (;;) {
    if (end === 0) break;
    const em = /&[A-Za-z0-9]+;$/.exec(u.slice(0, end));
    if (em) {
      end -= em[0].length;
      continue;
    }
    const c = u[end - 1];
    if (c === ')') {
      let open = 0;
      let close = 0;
      for (let i = 0; i < end; i++) {
        if (u[i] === '(') open++;
        else if (u[i] === ')') close++;
      }
      if (close > open) {
        end--;
        continue;
      }
      break;
    }
    if ('?!.,:;*_~\'"'.indexOf(c) >= 0) {
      end--;
      continue;
    }
    break;
  }
  return u.slice(0, end);
}

// Does a parsed inline node list contain a link (at any depth)? A link
// label may not contain a link, so an outer link whose label does is not
// a link at all.
function hasLink(nodes) {
  for (const nd of nodes) {
    // An autolink inside a label is allowed (marked renders nested
    // <a> tags for it); only a full [text](dest) link bars the label.
    if (nd.k === 'link' && !nd.auto) return true;
    if (nd.children && hasLink(nd.children)) return true;
  }
  return false;
}

// Try to parse a link (or image, when isImage) starting at text[i]
// ('[' at i, or '!' at i-1 for images). Returns { node, end } or null.
// The label's inline content is parsed recursively.
function tryLink(text, i, defs, state, isImage) {
  const n = text.length;
  const close = findLabelEnd(text, i);
  if (close < 0) return null;
  const label = text.slice(i + 1, close);
  if (label.length > 999) return null;
  let j = close + 1;
  let href = null;
  let title = null;
  if (j < n && text[j] === '(') {
    // Inline link: ( dest "title" ). If it is not a valid inline link,
    // the label may still be a shortcut reference (cm-568).
    let k = j + 1;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    let inlineOK = false;
    if (k < n && text[k] === ')') {
      href = '';
      j = k + 1;
      inlineOK = true;
    } else {
      const d = parseDest(text, k);
      if (d !== null) {
        href = d.dest;
        k = d.end;
        let m = k;
        while (m < n && (text[m] === ' ' || text[m] === '\t' || text[m] === '\n')) m++;
        let titleOK = true;
        if (m < n && text[m] !== ')') {
          const t = parseTitle(text, m);
          if (t === null) titleOK = false;
          else {
            title = t.title;
            m = t.end;
            while (m < n && (text[m] === ' ' || text[m] === '\t' || text[m] === '\n')) m++;
          }
        }
        if (titleOK && m < n && text[m] === ')') {
          j = m + 1;
          inlineOK = true;
        }
      }
    }
    if (!inlineOK) {
      // Fall through to the shortcut reference below.
      href = null;
      title = null;
      j = close + 1;
    }
  }
  if (href === null && j < n && text[j] === '[') {
    // Full reference [label][ref] or collapsed [label][]
    const close2 = findLabelEnd(text, j);
    if (close2 >= 0) {
      const refLabel = close2 === j + 1 ? label : text.slice(j + 1, close2);
      const ref = defs[normLabel(refLabel)];
      if (ref !== undefined) {
        href = ref.dest;
        title = ref.title;
        j = close2 + 1;
      } else {
        // A [ref] follows the label but names no definition: the
        // whole thing is not a link (cm-571). Do NOT fall back to the
        // shortcut reference -- '[foo][bar]' with no 'bar' def leaves
        // '[foo]' literal, and '[bar][baz]' is then tried on its own.
        return null;
      }
    }
  }
  if (href === null) {
    // Shortcut reference [label]
    const ref = defs[normLabel(label)];
    if (ref === undefined) return null;
    href = ref.dest;
    title = ref.title;
    j = close + 1;
  }
  href = cleanDest(href);
  const cleanT = title === null ? null : cleanTitle(title);
  if (isImage) {
    const children = scanInline(label, defs, state);
    const alt = textOf(children);
    return { node: { k: 'image', src: href, title: cleanT, alt }, end: j };
  }
  const saved = state.inLink;
  state.inLink = true;
  const children = scanInline(label, defs, state);
  state.inLink = saved;
  // A link label may not contain a link.
  if (hasLink(children)) return null;
  return { node: { k: 'link', href, title: cleanT, children }, end: j };
}

// Plain-text content of parsed inline nodes (for image alt text).
function textOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text' || nd.k === 'raw' || nd.k === 'code') out += nd.s;
    else if (nd.k === 'br') out += '\n';
    else if (nd.k === 'link' || nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') out += textOf(nd.children);
    else if (nd.k === 'image') out += nd.alt;
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.n);
  }
  return out;
}

// Scan text into inline nodes (delimiter processing applied afterwards
// by processDelims). defs is the document's link reference map, state
// is the document-level inline state.
function scanInline(text, defs, state) {
  const nodes = [];
  const n = text.length;
  let i = 0;
  let textStart = 0;
  const flushText = (upto) => {
    if (upto > textStart) nodes.push({ k: 'text', s: text.slice(textStart, upto) });
  };
  const pushNode = (nd) => {
    flushText(nd._from);
    nodes.push(nd);
    textStart = nd._to;
    i = nd._to;
  };
  while (i < n) {
    const c = text[i];
    // Raw-text elements: once a <pre>/<script>/... tag opened, inline
    // content is raw until its end tag.
    if (state.inRawBlock) {
      const m = /<\/\s*(pre|script|style|textarea)\s*>/i.exec(text.slice(i));
      if (m) {
        nodes.push({ k: 'raw', s: text.slice(textStart, i + m.index) });
        textStart = i + m.index;
        i = i + m.index;
        continue;
      }
      nodes.push({ k: 'raw', s: text.slice(textStart) });
      textStart = n;
      i = n;
      break;
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        // Backslash hard break: the newline and the next line's
        // leading whitespace are both consumed (oracle: 'foo\\\n     bar'
        // renders '<p>foo<br>bar</p>').
        let to = i + 2;
        while (to < n && (text[to] === ' ' || text[to] === '\t')) to++;
        pushNode({ k: 'br', _from: i, _to: to });
        continue;
      }
      if (nx !== undefined && PUNCT.has(nx)) {
        pushNode({ k: 'text', s: nx, _from: i, _to: i + 2 });
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let m = i;
      while (m < n && text[m] === '`') m++;
      const run = m - i;
      // Find a matching run of the same length.
      let k = m;
      let found = -1;
      while (k < n) {
        if (text[k] === '`') {
          let e = k;
          while (e < n && text[e] === '`') e++;
          if (e - k === run) {
            found = k;
            break;
          }
          k = e;
        } else k++;
      }
      if (found < 0) {
        i = m;
        continue;
      }
      let content = text.slice(m, found);
      // Line endings inside a code span become spaces first; then, if
      // the result begins and ends with a space (and is not all spaces),
      // one space is stripped from each end.
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      pushNode({ k: 'code', s: content, _from: i, _to: found + run });
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const isImage = c === '!';
      const at = isImage ? i + 1 : i;
      const hit = tryLink(text, at, defs, state, isImage);
      if (hit !== null) {
        const from = i;
        const to = hit.end;
        flushText(from);
        nodes.push(hit.node);
        textStart = to;
        i = to;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      let m = AUTOLINK_SCHEME_RE.exec(text.slice(i));
      if (m) {
        const href = cleanAutolinkUrl(m[1]);
        pushNode({ k: 'link', auto: true, href, title: null, children: [{ k: 'text', s: m[1] }], _from: i, _to: i + m[0].length });
        continue;
      }
      m = AUTOLINK_EMAIL_RE.exec(text.slice(i));
      if (m) {
        const addr = m[1];
        pushNode({ k: 'link', auto: true, href: 'mailto:' + cleanAutolinkUrl(addr), title: null, children: [{ k: 'text', s: addr }], _from: i, _to: i + m[0].length });
        continue;
      }
      m = HTML_TAG_RE.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const nm = TAG_NAME_RE.exec(tag);
        const name = nm ? nm[1].toLowerCase() : '';
        const closing = tag[1] === '/';
        if (!state.inLink && !closing && name === 'a') state.inLink = true;
        else if (state.inLink && closing && name === 'a') state.inLink = false;
        if (!closing && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) state.inRawBlock = true;
        else if (closing && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) state.inRawBlock = false;
        pushNode({ k: 'raw', s: tag, _from: i, _to: i + tag.length });
        continue;
      }
      i++;
      continue;
    }
    if (c === '&') {
      const e = entityAt(text, i);
      if (e !== null) {
        // Named entities render verbatim; numeric ones decode to a
        // character that is then escaped like ordinary text.
        if (e[2]) pushNode({ k: 'raw', s: e[0], _from: i, _to: i + e[1] });
        else pushNode({ k: 'text', s: e[0], _from: i, _to: i + e[1] });
        continue;
      }
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let m = i;
      while (m < n && text[m] === c) m++;
      const run = m - i;
      if (c === '~' && run > 2) {
        i = m;
        continue;
      }
      const prev = i > 0 ? text[i - 1] : undefined;
      const next = m < n ? text[m] : undefined;
      const [left, right] = flanking(prev, next);
      let canOpen;
      let canClose;
      if (c === '*') {
        canOpen = left;
        canClose = right;
      } else if (c === '_') {
        canOpen = left && (!right || isPunctChar(prev));
        canClose = right && (!left || isPunctChar(next));
      } else {
        canOpen = left;
        canClose = right;
      }
      if (canOpen || canClose) {
        flushText(i);
        nodes.push({ k: 'delim', ch: c, n: run, canOpen, canClose });
        textStart = m;
      }
      i = m;
      continue;
    }
    if (c === '\n') {
      // Hard break: two or more spaces before the newline.
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && text[k] === ' ') {
        spaces++;
        k--;
      }
      if (spaces >= 2) {
        flushText(i - spaces);
        nodes.push({ k: 'br' });
        // A hard break consumes the newline and the next line's leading
        // whitespace (oracle: 'foo  \n     bar' -> '<p>foo<br>bar</p>').
        let to = i + 1;
        while (to < n && (text[to] === ' ' || text[to] === '\t')) to++;
        textStart = to;
        i = to;
        continue;
      }
      i++;
      continue;
    }
    if (!state.inLink) {
      const prev = i > 0 ? text[i - 1] : undefined;
      // A www/scheme autolink is only attempted at a token boundary:
      // start, whitespace, '(', or an emphasis delimiter. A scheme
      // autolink is also attempted after a '<' that did not open an
      // autolink or tag (cm-602); www is not.
      const prevOK = prev === undefined || prev === ' ' || prev === '\t' || prev === '\n' || prev === '(' || prev === '*' || prev === '_' || prev === '~';
      const prevOKScheme = prevOK || prev === '<';
      if (c === 'w' && prevOK && text.startsWith('www.', i)) {
        const m = WWW_RE.exec(text.slice(i));
        if (m !== null) {
          const url = trimUrl(m[0]);
          if (url.length > 0) {
            flushText(i);
            nodes.push({ k: 'link', auto: true, href: 'http://' + cleanAutolinkUrl(url), title: null, children: [{ k: 'text', s: url }] });
            textStart = i + url.length;
            i = i + url.length;
            continue;
          }
        }
      }
      if (prevOKScheme && ((c === 'h' && (text.startsWith('http://', i) || text.startsWith('https://', i))) || (c === 'f' && text.startsWith('ftp://', i)))) {
        const m = SCHEME_RE.exec(text.slice(i));
        if (m !== null) {
          const url = trimUrl(m[0]);
          if (url.length > 0) {
            flushText(i);
            nodes.push({ k: 'link', auto: true, href: cleanAutolinkUrl(url), title: null, children: [{ k: 'text', s: url }] });
            textStart = i + url.length;
            i = i + url.length;
            continue;
          }
        }
      }
      if (prevOKScheme && c === 'm' && text.startsWith('mailto:', i)) {
        const m = EMAIL_RE.exec(text.slice(i + 7));
        if (m !== null) {
          const url = 'mailto:' + m[0];
          flushText(i);
          nodes.push({ k: 'link', auto: true, href: cleanAutolinkUrl(url), title: null, children: [{ k: 'text', s: url }] });
          textStart = i + url.length;
          i = i + url.length;
          continue;
        }
      }
      if (prevOKScheme && c === 'x' && text.startsWith('xmpp:', i)) {
        const m = EMAIL_RE.exec(text.slice(i + 5));
        if (m !== null) {
          let url = 'xmpp:' + m[0];
          const tail = text.slice(i + 5 + m[0].length);
          const rm = /^\/[A-Za-z0-9@.]+/.exec(tail);
          if (rm) url += rm[0];
          flushText(i);
          nodes.push({ k: 'link', auto: true, href: cleanAutolinkUrl(url), title: null, children: [{ k: 'text', s: url }] });
          textStart = i + url.length;
          i = i + url.length;
          continue;
        }
      }
      // Bare email: attempted only at a local-part token start (the
      // previous char is not a local-part char), because the match is
      // greedy and must include the whole local part.
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-') {
        if (prev === undefined || !/[A-Za-z0-9_.+-]/.test(prev)) {
          let k = i;
          const lim = Math.min(n, i + 320);
          while (k < lim && text[k] !== ' ' && text[k] !== '\t' && text[k] !== '\n' && text[k] !== '<') {
            if (text[k] === '@') break;
            k++;
          }
          if (k < lim && text[k] === '@') {
            const m = EMAIL_RE.exec(text.slice(i));
            if (m !== null) {
              const url = m[0];
              flushText(i);
              nodes.push({ k: 'link', auto: true, href: 'mailto:' + url, title: null, children: [{ k: 'text', s: url }] });
              textStart = i + url.length;
              i = i + url.length;
              continue;
            }
          }
        }
      }
    }
    i++;
  }
  flushText(n);
  for (const nd of nodes) {
    delete nd._from;
    delete nd._to;
  }
  return processDelims(nodes);
}

// ------------------------------------------------- delimiter processing
// Pair delimiter runs into <em>/<strong>/<del> (CommonMark algorithm).
// Delimiter nodes that survive are rendered as literal characters.
function processDelims(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.k !== 'delim' || !closer.canClose) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    let found = -1;
    while (oi >= 0) {
      const o = nodes[oi];
      if (o.k === 'delim' && o.ch === closer.ch && o.canOpen) {
        if (closer.ch === '~') {
          if (o.n !== closer.n) {
            oi--;
            continue;
          }
        } else if (
          (o.canClose || closer.canOpen) &&
          (o.n + closer.n) % 3 === 0 &&
          (o.n % 3 !== 0 || closer.n % 3 !== 0)
        ) {
          // Odd match: one of the two can both open and close, and the
          // lengths sum to a multiple of 3 without both being multiples
          // of 3, so these two cannot pair.
          oi--;
          continue;
        }
        found = oi;
        break;
      }
      oi--;
    }
    if (found < 0) {
      ci++;
      continue;
    }
    const o = nodes[found];
    let use;
    if (closer.ch === '~') use = o.n;
    else use = o.n >= 2 && closer.n >= 2 ? 2 : 1;
    const inner = nodes.slice(found + 1, ci);
    const kind = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const wrap = { k: kind, children: inner };
    const left = [];
    const right = [];
    if (o.n > use) left.push({ k: 'delim', ch: o.ch, n: o.n - use, canOpen: o.canOpen, canClose: o.canClose });
    if (closer.n > use) right.push({ k: 'delim', ch: closer.ch, n: closer.n - use, canOpen: closer.canOpen, canClose: closer.canClose });
    nodes.splice(found, ci - found + 1, ...left, wrap, ...right);
    ci = found + left.length;
  }
  return nodes;
}

// ------------------------------------------------------------ rendering
function escHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

function renderInline(nodes, out) {
  for (const nd of nodes) {
    if (nd.k === 'text') out.push(escHtml(nd.s));
    else if (nd.k === 'raw') out.push(nd.s);
    else if (nd.k === 'code') out.push('<code>' + escHtml(nd.s) + '</code>');
    else if (nd.k === 'br') out.push('<br>');
    else if (nd.k === 'delim') out.push(escHtml(nd.ch.repeat(nd.n)));
    else if (nd.k === 'em') {
      out.push('<em>');
      renderInline(nd.children, out);
      out.push('</em>');
    } else if (nd.k === 'strong') {
      out.push('<strong>');
      renderInline(nd.children, out);
      out.push('</strong>');
    } else if (nd.k === 'del') {
      out.push('<del>');
      renderInline(nd.children, out);
      out.push('</del>');
    } else if (nd.k === 'link') {
      out.push('<a href="' + escAttr(nd.href) + '"');
      if (nd.title !== null) out.push(' title="' + escAttr(nd.title) + '"');
      out.push('>');
      renderInline(nd.children, out);
      out.push('</a>');
    } else if (nd.k === 'image') {
      out.push('<img src="' + escAttr(nd.src) + '" alt="' + escAttr(nd.alt) + '"');
      if (nd.title !== null) out.push(' title="' + escAttr(nd.title) + '"');
      out.push('>');
    }
  }
}

function escAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // A '&' that starts a valid entity reference is kept verbatim; a
    // bare '&' is escaped.
    if (c === '&') {
      const e = entityAt(s, i);
      if (e !== null) {
        // Keep the whole entity reference verbatim.
        out += s.slice(start, i) + s.slice(i, i + e[1]);
        i += e[1] - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
      continue;
    }
    let rep = null;
    if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// ------------------------------------------------------------- public API
// Parse markdown to HTML. Input is the whole document.
function parse(src) {
  const defs = {};
  const root = parseBlocks(src, defs);
  const state = newInlineState();
  // A trailing newline is emitted after a top-level HTML block that is
  // the last block only when the source ends with a newline and does not
  // end with a blank line.
  const norm = src.replace(/\r\n?/g, '\n');
  const endsNL = norm.endsWith('\n');
  const withoutFinalNL = endsNL ? norm.slice(0, -1) : norm;
  const endsBlank = withoutFinalNL.endsWith('\n') || withoutFinalNL === '';
  const htmlTrailNL = endsNL && !endsBlank;
  const out = [];
  renderBlocks(root.children, defs, state, out, true, htmlTrailNL);
  return out.join('');
}

export { parse };

// -------------------------------------------------------- block renderer
function alignAttr(a) {
  return a ? ' align="' + a + '"' : '';
}

function renderItem(item, loose, defs, state, out) {
  out.push('<li>');
  const kids = item.children.filter((c) => !c.dead);
  let prefix = '';
  if (item.task !== null) {
    prefix = '<input ' + (item.task ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }
  for (let ci = 0; ci < kids.length; ci++) {
    const child = kids[ci];
    if (child.t === 'para' && !loose) {
      if (ci === 0) out.push(prefix);
      renderInline(scanInline(child.text, defs, state), out);
    } else if (child.t === 'para') {
      out.push('<p>');
      if (ci === 0) out.push(prefix);
      renderInline(scanInline(child.text, defs, state), out);
      out.push('</p>\n');
    } else {
      if (ci === 0) out.push(prefix);
      renderBlocks([child], defs, state, out, false, false);
    }
  }
  if (kids.length === 0) out.push(prefix);
  out.push('</li>\n');
}

function renderBlocks(blocks, defs, state, out, isTop, htmlTrailNL) {
  // Index of the last live block (dead blocks are skipped).
  let lastLive = -1;
  for (let i = 0; i < blocks.length; i++) if (!blocks[i].dead) lastLive = i;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.dead) continue;
    if (b.t === 'para') {
      out.push('<p>');
      renderInline(scanInline(b.text, defs, state), out);
      out.push('</p>\n');
    } else if (b.t === 'heading') {
      out.push('<h' + b.level + '>');
      renderInline(scanInline(b.text, defs, state), out);
      out.push('</h' + b.level + '>\n');
    } else if (b.t === 'fence') {
      out.push('<pre><code');
      if (b.lang) out.push(' class="language-' + escAttr(b.lang) + '"');
      out.push('>');
      let content = b.lines.join('\n');
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] !== '') content += '\n';
      out.push(escHtml(content));
      out.push('</code></pre>\n');
    } else if (b.t === 'icode') {
      out.push('<pre><code>');
      let content = b.lines.join('\n');
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] !== '') content += '\n';
      out.push(escHtml(content));
      out.push('</code></pre>\n');
    } else if (b.t === 'hr') {
      out.push('<hr>\n');
    } else if (b.t === 'html') {
      // An HTML block is its lines joined by newlines. A trailing
      // newline is emitted only for a top-level block that is the last
      // block and whose source does not end with a blank line.
      out.push(b.lines.join('\n'));
      if (isTop && bi === lastLive && htmlTrailNL) out.push('\n');
    } else if (b.t === 'quote') {
      out.push('<blockquote>\n');
      renderBlocks(b.children, defs, state, out, false, false);
      out.push('</blockquote>\n');
    } else if (b.t === 'list') {
      if (b.ordered) {
        out.push('<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n');
      } else {
        out.push('<ul>\n');
      }
      for (const item of b.items) renderItem(item, b.loose, defs, state, out);
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
    } else if (b.t === 'table') {
      out.push('<table>\n<thead>\n<tr>\n');
      const headCells = splitTableRow(b.header[0]);
      for (let ci = 0; ci < b.aligns.length; ci++) {
        const cell = ci < headCells.length ? headCells[ci] : '';
        out.push('<th' + alignAttr(b.aligns[ci]) + '>');
        renderInline(scanInline(cell, defs, state), out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      // A table with no body rows has no <tbody> at all (gfm-205).
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          const cells = splitTableRow(row);
          out.push('<tr>\n');
          for (let ci = 0; ci < b.aligns.length; ci++) {
            const cell = ci < cells.length ? cells[ci] : '';
            out.push('<td' + alignAttr(b.aligns[ci]) + '>');
            renderInline(scanInline(cell, defs, state), out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
    }
  }
}
