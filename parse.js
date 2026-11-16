// parse.js — a fast, dependency-free stand-in for marked 18.1.3 (default options, GFM on).
// parse(markdown) returns exactly the HTML that marked.parse(markdown) returns, byte
// for byte, for every input string.
//
// How it works: a block pass turns the source into a token list (headings, lists,
// tables, quotes, code, paragraphs...), an inline pass turns each paragraph-like span
// into inline tokens (emphasis, links, code spans...), and a renderer walks the tokens
// to HTML. The shape mirrors marked's own pipeline, but the scanners work on indexes
// into the source with sticky patterns instead of slicing the remainder over and over,
// and the emphasis pre-masking that marked does with regex replaces is done by small
// hand-written scans. Nothing is kept between parse() calls: every call starts from a
// clean slate, so the same input always yields the same output.

/* ------------------------------------------------------------ small utilities */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/;
const ESC_ANY_G = /[&<>"']/g;
const ESC_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_KEEP_ENT_G = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML metacharacters. With encodeAll every & becomes &amp;; otherwise an &
// that already starts a valid entity or numeric reference is left alone.
function escHtml(text, encodeAll) {
  if (encodeAll) {
    if (ESC_ANY.test(text)) return text.replace(ESC_ANY_G, (ch) => ESC_MAP[ch]);
  } else if (ESC_KEEP_ENT.test(text)) {
    return text.replace(ESC_KEEP_ENT_G, (ch) => ESC_MAP[ch]);
  }
  return text;
}

const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's unescape: only numeric character references are decoded, named entities
// pass through untouched, and a bare & becomes &amp;.
function decodeNumRefs(text) {
  if (!text.includes('&') || !NUM_REF_TEST.test(text)) return text;
  return text.replace(NUM_REF_RE, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// marked's cleanUrl: encodeURI with %25 folded back to %, null when encoding throws.
function tidyUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// marked's splitCells: split a table row on unescaped pipes, trim the cells, and pad
// or truncate to the header's column count when a count is given.
function splitRow(rowText, count) {
  const cells = rowText
    .replace(/\|/g, (match, offset, str) => {
      let escaped = false;
      let p = offset;
      while (--p >= 0 && str[p] === '\\') escaped = !escaped;
      return escaped ? '|' : ' |';
    })
    .split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip a trailing run of one character, as marked's rtrim does.
function stripTrail(str, ch) {
  const n = str.length;
  let s = 0;
  while (s < n && str.charAt(n - s - 1) === ch) s++;
  return s === 0 ? str : str.slice(0, n - s);
}

const BLANK_LINE_RE = /^[ \t]*$/;

// marked's trimCode: an indented code block keeps at most one trailing blank line.
function trimCodeTail(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE_RE.test(lines[t])) t--;
  return lines.length - t <= 2 ? text : lines.slice(0, t + 1).join('\n');
}

// marked's label normalisation for link reference definitions.
function normRef(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// marked's findClosingDelimiter: the index of the unbalanced closer of a pair,
// -2 when the text ends still inside the pair, -1 when there is none or it balances.
function findCloseDelim(text, pair) {
  if (text.indexOf(pair[0]) === -1 && text.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < text.length; n++) {
    if (text[n] === '\\') n++;
    else if (text[n] === pair[0]) depth++;
    else if (text[n] === pair[1] && (depth--, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

// marked's unindent: expand tabs to 4-column stops, starting from column startCol.
function expandTab(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const FENCE_INDENT_RE = /^(\s+)(?:```)/;
const LEAD_WS_RE = /^\s+/;

// marked's indent compensation: fenced code content is dedented by the fence's indent.
function dedentFenced(raw, text) {
  const match = raw.match(FENCE_INDENT_RE);
  if (match === null) return text;
  const indent = match[1];
  return text
    .split('\n')
    .map((line) => {
      const space = line.match(LEAD_WS_RE);
      if (space === null) return line;
      return line.slice(Math.min(space[0].length, indent.length));
    })
    .join('\n');
}

/* ------------------------------------------------------------ sticky patterns */

// Sticky twins of marked's anchored rules: same pattern, but every top-level ^ anchor
// (at the start of the pattern or of an alternative) is dropped and the 'y' flag added,
// so a rule can be matched at an index inside a longer string. A ^ inside a group or a
// character class is kept: marked's substring matches anchor those at the substring
// start too, but only when the group is entered at position 0, and the rules used with
// sticky matching have none.
function toSticky(re) {
  const src = re.source;
  let out = '';
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      out += ch + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      out += ch;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '^' && depth === 0) continue;
    out += ch;
  }
  const flags = re.flags.replace(/[gy]/g, '');
  return new RegExp(out, flags + 'y');
}

// Run a sticky pattern at an exact position in the source.
function execAtPos(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

// The block grammar: marked's GFM block rules, each paired with its sticky twin.
const NL = /^(?:[ \t]*(?:\n|$))+/;
const NL_Y = toSticky(NL);
const CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const CODE_Y = toSticky(CODE);
const FENCE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const FENCE_Y = toSticky(FENCE);
const HEAD = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const HEAD_Y = toSticky(HEAD);
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HR_Y = toSticky(HR);
const QUOTE = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;
const QUOTE_Y = toSticky(QUOTE);
const LIST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const LIST_Y = toSticky(LIST);
const HTML = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const HTML_Y = toSticky(HTML);
const DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const DEF_Y = toSticky(DEF);
const TABLE = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const TABLE_Y = toSticky(TABLE);
const LHEAD = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEAD_Y = toSticky(LHEAD);
const PARA = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const PARA_Y = toSticky(PARA);
const TEXT = /^[^\n]+/;
const TEXT_Y = toSticky(TEXT);

// The small patterns marked's T table holds, used on substrings exactly as marked uses them.
const INDENT_STRIP_RE = /^(?: {0,3}\t| {1,4})/gm;
const LINK_BRACKET_RE = /\\([\[\]])/g;
const TRAIL_HASH_RE = /#$/;
const TRAIL_WS_RE = /[ \t]$/;
const NON_SPACE_RE = /[^ ]/;
const LEAD_SPACE_TAB_RE = /^[ \t]+/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const QUOTE_MARK_RE = /^ {0,3}>/;
const QUOTE_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_STRIP_RE = /^ {0,3}>[ \t]?/gm;
const QUOTE_MARK_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const IS_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX_RE = /^\[[ xX]\][ \t]+/;
const TASK_BOX_RE = /\[[ xX]\]/;
const ANY_LINE_RE = /\n.*\n/;
const HREF_ANGLE_RE = /^<(.*)>$/;
const TABLE_DELIM_RE = /[:|]/;
const TABLE_ALIGN_TRIM_RE = /^\||\| *$/g;
const ROW_TRAIL_BLANK_RE = /\n[ \t]*$/;
const ALIGN_RIGHT_RE = /^ *-+: *$/;
const ALIGN_CENTER_RE = /^ *:-+: *$/;
const ALIGN_LEFT_RE = /^ *:-+ *$/;
const A_OPEN_RE = /^<a /i;
const A_CLOSE_RE = /^<\/a>/i;
const PRE_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const ANGLE_OPEN_RE = /^</;
const ANGLE_CLOSE_RE = />$/;
const ALNUM_RE = /[\p{L}\p{N}]/u;

// A list item's bullet, as a sticky pattern: the bullet, then the rest of its line.
function itemPattern(bullet) {
  return new RegExp(`( {0,3}${bullet})((?:[ \\t][^\\n]*)?(?:\\n|$))`, 'y');
}

// marked caches the "begin" patterns through a clamp: the variant used for indent R is
// the one built for clamp(R - 1, 0, 3).
function clampInd(r) {
  return Math.max(0, Math.min(3, r - 1));
}
const BULLET_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const HR_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const FENCE_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const HEAD_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const HTML_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const QUOTE_RES = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}>`));

// The inline grammar: marked's GFM inline rules, each paired with its sticky twin.
const IN_ESC = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const IN_ESC_Y = toSticky(IN_ESC);
const IN_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const IN_TAG_Y = toSticky(IN_TAG);
const IN_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const IN_LINK_Y = toSticky(IN_LINK);
const IN_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const IN_REFLINK_Y = toSticky(IN_REFLINK);
const IN_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const IN_NOLINK_Y = toSticky(IN_NOLINK);
const IN_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const IN_CODE_Y = toSticky(IN_CODE);
const IN_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const IN_BR_Y = toSticky(IN_BR);
const IN_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const IN_AUTOLINK_Y = toSticky(IN_AUTOLINK);
const IN_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const IN_URL_Y = toSticky(IN_URL);
const IN_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const IN_TEXT_Y = toSticky(IN_TEXT);
const IN_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const IN_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const IN_EM_L = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const IN_EM_L_Y = toSticky(IN_EM_L);
const IN_EM_R_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const IN_EM_R_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const IN_DEL_L = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const IN_DEL_L_Y = toSticky(IN_DEL_L);
const IN_DEL_R = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const IN_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

// One combined pattern for the three things the mask hides: a bracketed link, a code
// span, and an inline tag. The empty first group marks the code-span alternative so
// the replacer can tell it apart from a link.
const SKIP_ALL_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

/* ------------------------------------------------------------ per-parse state */

// Link reference definitions collected by the block pass, keyed by normalised label.
let REFS = Object.create(null);
// Inline work the block pass defers: { src, tokens } pairs, filled in after lexing.
let JOBS = [];
// Lexer flags marked keeps on its instance: whether the inline cursor sits inside a
// link or a raw (pre/code/kbd/script) block, whether a link was already emitted for
// the current span, whether a closing paren could still appear, and whether the block
// pass is at the top level (paragraphs are only lexed there).
const ST = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };

// Register a span for the inline pass and hand back its (still empty) token list.
function deferInline(text) {
  const tokens = [];
  JOBS.push({ src: text, tokens });
  return tokens;
}

/* ------------------------------------------- masking (marked's emphasis pre-pass) */

// Does this span contain a link that resolves (inline or by reference)? Used while
// deciding whether a reference link inside another label may itself be masked.
function hasLinkIn(text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(SKIP_ALL_RE)) {
    if (IN_LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(REFS, normRef(s.slice(r + 1, -1)))) &&
      !(r > 1 && hasLinkIn(s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// The reflink stage of the mask: replace a resolving reference link's label with
// filler so its delimiters cannot take part in emphasis matching.
function maskRefCb(r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(REFS, normRef(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (hasLinkIn(inner)) {
      return '[' + inner.replace(REFLINK_SEARCH, maskRefCb) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

const PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

// Stage 2 of the mask: marked's anyPunctuationOutsideCode replace, same semantics —
// an escaped punctuation becomes '+' filler, a code span keeps its fences and has its
// backticks inside turned into '+'.
function maskEscCode(s) {
  if (!s.includes('\\') && !s.includes('`')) return s;
  return s.replace(PUNCT_OUTSIDE_CODE_RE, (n, run, esc) =>
    esc
      ? '+'.repeat(n.length)
      : run
        ? run + n.slice(run.length, -run.length).replace(/`/g, '+') + run
        : n,
  );
}

// Stage 3 of the mask: marked's blockSkip replace — a link, code span or tag becomes
// '[' + filler + ']', so nothing inside it can open or close emphasis.
function maskSkip(s) {
  if (!s.includes('[') && !s.includes('`') && !s.includes('<')) return s;
  return s.replace(SKIP_ALL_RE, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
}

// The whole mask: reflinks first, then escapes and code spans, then links and tags.
function maskSource(src) {
  let t = src;
  if (t.includes('[')) t = t.replace(REFLINK_SEARCH, maskRefCb);
  t = maskEscCode(t);
  t = maskSkip(t);
  return t;
}

const DELIM_RUN_RE = /([*_~])\1*/g;

// marked's findLastPossibleCloser scan over the masked source: for each of * and _
// the index of the last delimiter run that is not preceded by whitespace, and the
// same for ~. The emphasis scanners use these as hard upper bounds.
function findClosers(masked) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  DELIM_RUN_RE.lastIndex = 0;
  let m;
  while ((m = DELIM_RUN_RE.exec(masked)) !== null) {
    const idx = m.index;
    const prev = idx === 0 ? '\n' : masked[idx - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      const r = m[1];
      if (r === '~') lastDel = idx;
      else lastEmStrong[r] = idx;
    }
  }
  return { lastEmStrong, lastDel };
}

/* ------------------------------------------------------------ inline tokenizers */

function tryEscape(src, pos) {
  const cap = execAtPos(IN_ESC_Y, src, pos);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  return undefined;
}

function tryTag(src, pos) {
  const cap = execAtPos(IN_TAG_Y, src, pos);
  if (!cap) return undefined;
  if (!ST.inLink && A_OPEN_RE.test(cap[0])) ST.inLink = true;
  else if (ST.inLink && A_CLOSE_RE.test(cap[0])) ST.inLink = false;
  if (!ST.inRawBlock && PRE_OPEN_RE.test(cap[0])) ST.inRawBlock = true;
  else if (ST.inRawBlock && PRE_CLOSE_RE.test(cap[0])) ST.inRawBlock = false;
  return { type: 'html', raw: cap[0], inLink: ST.inLink, inRawBlock: ST.inRawBlock, block: false, text: cap[0] };
}

// marked's checkLinkTextForNestedTag: a link label that contains a tag whose raw form
// reaches past the end of the label is not a link at all.
function labelHasNestedTag(src, pos, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const cap = execAtPos(IN_CODE_Y, label, s);
      if (cap) {
        s += cap[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(pos + offset + s);
    const cap = IN_TAG.exec(rest) || IN_AUTOLINK.exec(rest);
    if (cap) {
      if (cap[0].length > label.length - s) return true;
      s += cap[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, tokenising its label inline. A link whose label already
// emitted a link is dropped (marked never nests links); an image is always kept.
function makeLinkToken(cap, href, title, raw) {
  const text = cap[1].replace(LINK_BRACKET_RE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = ST.inLink;
  const savedEmitted = ST.linkEmitted;
  const savedRawBlock = ST.inRawBlock;
  ST.inLink = true;
  ST.linkEmitted = false;
  const tokens = tokenizeInline(text, []);
  const emitted = ST.linkEmitted;
  ST.linkEmitted = savedEmitted;
  ST.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ST.inRawBlock = savedRawBlock;
      return undefined;
    }
    ST.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

function tryLink(src, pos) {
  if (ST.linkParenPossible === false) return undefined;
  const cap = execAtPos(IN_LINK_Y, src, pos);
  if (!cap) return undefined;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasNestedTag(src, pos, cap[1], offset)) return undefined;
  let href = cap[2].trim();
  if (ANGLE_OPEN_RE.test(href)) {
    if (!ANGLE_CLOSE_RE.test(href)) return undefined;
    const trimmed = stripTrail(href.slice(0, -1), '\\');
    if ((href.length - trimmed.length) % 2 === 0) return undefined;
  } else {
    const balance = findCloseDelim(cap[2], '()');
    if (balance === -2) return undefined;
    if (balance > -1) {
      const h = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + balance;
      cap[2] = cap[2].substring(0, balance);
      cap[0] = cap[0].substring(0, h).trim();
      cap[3] = '';
    }
  }
  const trimmedRaw = stripTrail(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - trimmedRaw.length) % 2 === 0) return undefined;
  let outHref = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  outHref = outHref.trim();
  if (ANGLE_OPEN_RE.test(outHref)) outHref = outHref.slice(1, -1);
  return makeLinkToken(
    cap,
    outHref ? outHref.replace(IN_ANY_PUNCT, '$1') : outHref,
    title ? title.replace(IN_ANY_PUNCT, '$1') : title,
    cap[0],
  );
}

function tryRefLink(src, pos) {
  const cap = execAtPos(IN_REFLINK_Y, src, pos) || execAtPos(IN_NOLINK_Y, src, pos);
  if (!cap) return undefined;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasNestedTag(src, pos, cap[1], offset)) return undefined;
  const link = REFS[normRef(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLinkToken(cap, link.href, link.title, cap[0]);
}

// marked's [...cap[0]].length - 1 for an LDelim match: an ASCII delimiter run plus at
// most one trailing code point, counted in code points, not UTF-16 units.
function openerLen(cap0) {
  let n = cap0.length - 1;
  if (cap0.length >= 2) {
    const lastCc = cap0.charCodeAt(cap0.length - 1);
    const prevCc = cap0.charCodeAt(cap0.length - 2);
    if (lastCc >= 0xdc00 && lastCc <= 0xdfff && prevCc >= 0xd800 && prevCc <= 0xdbff) n--;
  }
  return n;
}

// UTF-16 length of the first code point of s (marked's [...s][0].length).
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) {
    const c2 = s.charCodeAt(1);
    if (c2 >= 0xdc00 && c2 <= 0xdfff) return 2;
  }
  return 1;
}

function tryEmStrong(src, pos, masked, closers, prevChar) {
  // No possible closer at or before pos means the LDelim exec cannot succeed usefully:
  // marked's v >= Q check would reject with Q >= pos, and v === pos forces k === 0,
  // which means no delimiter group, an earlier return in marked as well.
  if (closers.lastEmStrong[src[pos]] <= pos) return undefined;
  const cap = execAtPos(IN_EM_L_Y, src, pos);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delim = cap[0][0];
  const onlySame = prevChar === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const prevPoint = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const prevIsPunct = prevPoint === '*' || prevPoint === '_' || !!IN_PUNCT.exec(prevPoint);
  const effPrev = l < i ? prevPoint : prevChar;
  const punctCond = l < i ? prevIsPunct : !!IN_PUNCT.exec(effPrev);
  if (cap[4] && ALNUM_RE.test(effPrev)) return undefined;
  const afterPunct = cap[1] || cap[3] || '';
  if (!afterPunct || !effPrev || punctCond) {
    const openLen = openerLen(cap[0]);
    let m = openLen;
    let f = 0;
    const y = i - l + openLen;
    const ruleOfThree = !!prevPoint.trim() && (!!afterPunct || (delim === '*' && !prevIsPunct));
    const rule = delim === '*' ? IN_EM_R_AST : IN_EM_R_UND;
    const lastCloser = closers.lastEmStrong[delim];
    const start = i + openLen;
    if (lastCloser < start) return undefined;
    const rest = masked.slice(start);
    const limit = lastCloser - start;
    rule.lastIndex = 0;
    let rcap;
    while ((rcap = rule.exec(rest)) !== null && !(rcap.index > limit)) {
      const g = rcap[1] || rcap[2] || rcap[3] || rcap[4] || rcap[5] || rcap[6];
      if (!g) continue;
      let b = g.length; // g is a run of one ASCII delimiter char
      if (rcap[3] || rcap[4]) {
        m += b;
        continue;
      } else if (rcap[5] || rcap[6] || ruleOfThree) {
        if (onlySame && (rcap[5] || rcap[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const firstLen = firstCpLen(rcap[0]);
      const raw = src.slice(pos, pos + openLen + rcap.index + firstLen + b);
      if (Math.min(openLen, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: tokenizeInline(text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: tokenizeInline(text, []) };
    }
  }
  return undefined;
}

function tryCodeSpan(src, pos) {
  const cap = execAtPos(IN_CODE_Y, src, pos);
  if (!cap) return undefined;
  let text = cap[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(text);
  const hasSpaceEdges = /^ /.test(text) && / $/.test(text);
  if (hasNonSpace && hasSpaceEdges) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function tryBr(src, pos) {
  const cap = execAtPos(IN_BR_Y, src, pos);
  if (cap) return { type: 'br', raw: cap[0] };
  return undefined;
}

function tryDel(src, pos, masked, closers, prevChar) {
  if (closers.lastDel <= pos) return undefined;
  const cap = execAtPos(IN_DEL_L_Y, src, pos);
  if (!cap) return undefined;
  if (!(cap[1] || '') || !prevChar || IN_PUNCT.exec(prevChar)) {
    const openLen = openerLen(cap[0]);
    let openers = openLen;
    const lastCloser = closers.lastDel;
    const start = pos + openLen;
    if (lastCloser < start) return undefined;
    const rest = masked.slice(start);
    const limit = lastCloser - start;
    const rule = IN_DEL_R;
    rule.lastIndex = 0;
    let rcap;
    while ((rcap = rule.exec(rest)) !== null && !(rcap.index > limit)) {
      const g = rcap[1] || rcap[2] || rcap[3] || rcap[4] || rcap[5] || rcap[6];
      if (!g) continue;
      let runLen = g.length; // g is a run of ASCII tildes
      if (runLen !== openLen) continue;
      if (rcap[3] || rcap[4]) {
        openers += runLen;
        continue;
      }
      openers -= runLen;
      if (openers > 0) continue;
      runLen = Math.min(runLen, runLen + openers);
      const firstLen = firstCpLen(rcap[0]);
      const raw = src.slice(pos, pos + openLen + rcap.index + firstLen + runLen);
      const text = raw.slice(openLen, raw.length - openLen);
      return { type: 'del', raw, text, tokens: tokenizeInline(text, []) };
    }
  }
  return undefined;
}

function tryAutolink(src, pos) {
  const cap = execAtPos(IN_AUTOLINK_Y, src, pos);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// Exact pre-filter for tryUrl: the url rule can only match when the maximal run of
// email-local characters at pos is followed by '@' (bare email) or '://' (protocol),
// or the text at pos starts with 'www.', 'mailto:' or 'xmpp:'. No false negatives.
function urlMayMatch(src, pos) {
  if (src.startsWith('www.', pos) || src.startsWith('mailto:', pos) || src.startsWith('xmpp:', pos)) return true;
  let j = pos;
  const n = src.length;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 46 ||
      c === 95 ||
      c === 43 ||
      c === 45
    ) {
      j++;
    } else break;
  }
  if (j === pos) return false;
  if (src[j] === '@') return true;
  return src[j] === ':' && src[j + 1] === '/' && src[j + 2] === '/';
}

function tryUrl(src, pos) {
  if (!urlMayMatch(src, pos)) return undefined;
  const cap = execAtPos(IN_URL_Y, src, pos);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = IN_BACKPEDAL.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tryText(src, pos) {
  const cap = execAtPos(IN_TEXT_Y, src, pos);
  if (!cap) return undefined;
  const inRaw = ST.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumRefs(cap[0]), escaped: inRaw };
}

// Chars a GFM url token (protocol, www., mailto/xmpp, or bare email) can start with.
function isUrlStart(c) {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 46 || // .
    c === 95 || // _
    c === 43 || // +
    c === 45 // -
  );
}

function tokenizeInline(src, tokens = []) {
  const saved = ST.linkParenPossible;
  ST.linkParenPossible = saved && src.includes(')');
  const out = tokenizeInlineInner(src, tokens);
  ST.linkParenPossible = saved;
  return out;
}

const DELIM_CHAR_RE = /[*_~]/;
// Shared sentinel for spans with no delimiter characters: no emphasis or
// strikethrough can open or close in them, so the closer scan can be skipped.
const NO_CLOSERS = { lastEmStrong: { '*': -1, _: -1 }, lastDel: -1 };
function tokenizeInlineInner(src, tokens) {
  let masked = src;
  let hasDelim = false;
  if (DELIM_CHAR_RE.test(src)) {
    masked = maskSource(src);
    hasDelim = true;
  }
  const closers = hasDelim ? findClosers(masked) : NO_CLOSERS;
  let pos = 0;
  let prevChar = '';
  let keepPrev = false;
  let lastRemaining = Infinity;
  const len = src.length;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining < lastRemaining) lastRemaining = remaining;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    // First-char dispatch: each tokenizer's rule can only match at its own start
    // characters, so trying the rest (as marked does) only wastes regex calls.
    // The attempt order within each character matches marked's tokenizer order.
    let tok;
    const c = src.charCodeAt(pos);
    if (c === 92) {
      // backslash: escape, then br
      tok = tryEscape(src, pos) || tryBr(src, pos);
    } else if (c === 60) {
      // <: tag, then autolink
      tok = tryTag(src, pos) || tryAutolink(src, pos);
    } else if (c === 91 || c === 33) {
      // [ or !: link, then reflink (whose text result merges like marked's)
      tok = tryLink(src, pos);
      if (!tok) {
        tok = tryRefLink(src, pos);
        if (tok) {
          pos += tok.raw.length;
          const last = tokens[tokens.length - 1];
          if (tok.type === 'text' && last?.type === 'text') {
            last.raw += tok.raw;
            last.text += tok.text;
          } else tokens.push(tok);
          continue;
        }
      }
    } else if (c === 42 || c === 95) {
      // * or _: emStrong (url may still match at _ after emStrong fails)
      tok = tryEmStrong(src, pos, masked, closers, prevChar);
    } else if (c === 96) {
      tok = tryCodeSpan(src, pos);
    } else if (c === 126) {
      tok = tryDel(src, pos, masked, closers, prevChar);
    } else if (c === 32) {
      tok = tryBr(src, pos);
    }
    if (!tok && !ST.inLink && isUrlStart(c)) tok = tryUrl(src, pos);
    if (tok) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    tok = tryText(src, pos);
    if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += tok.raw.length;
    if (tok.raw.charAt(tok.raw.length - 1) !== '_') prevChar = tok.raw.charAt(tok.raw.length - 1);
    keepPrev = true;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') {
      last.raw += tok.raw;
      last.text += tok.text;
    } else tokens.push(tok);
  }
  return tokens;
}

/* ------------------------------------------------------------ block tokenizers */

function tryCode(src, pos) {
  const cap = execAtPos(CODE_Y, src, pos);
  if (!cap) return undefined;
  const raw = trimCodeTail(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(INDENT_STRIP_RE, '') };
}

function tryFence(src, pos) {
  const cap = execAtPos(FENCE_Y, src, pos);
  if (!cap) return undefined;
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(IN_ANY_PUNCT, '$1') : cap[2],
    text: dedentFenced(cap[0], cap[3] || ''),
  };
}

function tryHeading(src, pos) {
  const cap = execAtPos(HEAD_Y, src, pos);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (TRAIL_HASH_RE.test(text)) {
    const trimmed = stripTrail(text, '#');
    if (!trimmed || TRAIL_WS_RE.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: stripTrail(cap[0], '\n'), depth: cap[1].length, text, tokens: deferInline(text) };
}

function tryHr(src, pos) {
  const cap = execAtPos(HR_Y, src, pos);
  if (cap) return { type: 'hr', raw: stripTrail(cap[0], '\n') };
  return undefined;
}

function tryQuote(src, pos) {
  const cap = execAtPos(QUOTE_Y, src, pos);
  if (!cap) return undefined;
  let lines = stripTrail(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (QUOTE_MARK_RE.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(QUOTE_MARK_WS_RE, (m, marker, ws) => marker + expandTab(ws, marker.length))
      .replace(QUOTE_SETEXT_RE, '\n    $1')
      .replace(QUOTE_STRIP_RE, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const savedTop = ST.top;
    ST.top = true;
    tokenizeBlocks(chunkText, tokens, true);
    ST.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const rest = lines.join('\n').replace(QUOTE_STRIP_RE, '');
      const mergedSrc = last.raw + '\n' + rest;
      const merged = tryQuote(mergedSrc, 0);
      tokens[tokens.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && QUOTE_MARK_RE.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const mergedSrc = last.raw + '\n' + lines.join('\n');
      const merged = tryList(mergedSrc, 0);
      tokens[tokens.length - 1] = merged;
      let usedLines = 0;
      if (merged.raw.length > last.raw.length) {
        usedLines = mergedSrc.slice(last.raw.length + 1, merged.raw.length).split('\n').length;
      }
      if (usedLines > 0) {
        const used = lines.slice(0, usedLines).join('\n');
        raw += '\n' + used;
        text += '\n' + used;
      }
      lines = lines.slice(usedLines);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// line.replace(leadingSpaceTab, s => expandTab(s, startCol)) without the regex when tab-free.
function expandLeadTabs(line, startCol) {
  let i = 0;
  const n = line.length;
  let hasTab = false;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') hasTab = true;
    i++;
  }
  if (i === 0 || !hasTab) return line;
  return expandTab(line.slice(0, i), startCol) + line.slice(i);
}

// Chars that can start a block interrupting a list item (fences/heading/html/quote/bullet/hr).
function mayBeginBlock(c) {
  return (
    c === 96 || // `
    c === 126 || // ~
    c === 35 || // #
    c === 60 || // <
    c === 62 || // >
    c === 45 || // -
    c === 42 || // *
    c === 43 || // +
    c === 95 || // _
    (c >= 48 && c <= 57) // 0-9
  );
}

function tryList(src, pos) {
  const cap = execAtPos(LIST_Y, src, pos);
  if (!cap) return undefined;
  const start = pos;
  let p = pos;
  const firstLine = () => {
    const nl = src.indexOf('\n', p);
    return nl === -1 ? src.slice(p) : src.slice(p, nl);
  };
  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = itemPattern(bull);
  let endNextLineBlank = false;
  while (p < src.length) {
    let itemStartsBlank = false;
    const itemCap = execAtPos(itemRe, src, p);
    if (!itemCap || execAtPos(HR_Y, src, p)) break;
    const itemStart = p;
    p += itemCap[0].length;
    const cap2 = itemCap[2];
    const nl2 = cap2.indexOf('\n');
    const line = nl2 === -1 ? cap2 : cap2.slice(0, nl2);
    const bulletLen = itemCap[1].length;
    let itemLine = expandLeadTabs(line, bulletLen);
    let nextLine = firstLine();
    let blank = !itemLine.trim();
    let indent = 0;
    let content = '';
    if (blank) {
      indent = bulletLen + 1;
    } else {
      indent = itemLine.search(NON_SPACE_RE);
      if (indent > 4) indent = 1;
      content = itemLine.slice(indent);
      indent += bulletLen;
    }
    if (blank && BLANK_LINE_RE.test(nextLine)) {
      p += nextLine.length + 1;
      itemStartsBlank = true;
    }
    if (!itemStartsBlank) {
      const ci = clampInd(indent);
      const nextBulletRe = BULLET_RES[ci];
      const hrRe = HR_RES[ci];
      const fencesRe = FENCE_RES[ci];
      const headingRe = HEAD_RES[ci];
      const htmlRe = HTML_RES[ci];
      const quoteRe = QUOTE_RES[ci];
      while (p < src.length) {
        const rawLine = firstLine();
        nextLine = rawLine;
        const lineContent = expandLeadTabs(rawLine, 0);
        let gi = 0;
        while (gi < rawLine.length && (rawLine[gi] === ' ' || rawLine[gi] === '\t')) gi++;
        if (
          mayBeginBlock(rawLine.charCodeAt(gi)) &&
          (fencesRe.test(rawLine) ||
            headingRe.test(rawLine) ||
            htmlRe.test(rawLine) ||
            quoteRe.test(rawLine) ||
            nextBulletRe.test(rawLine) ||
            hrRe.test(rawLine))
        ) {
          break;
        }
        if (lineContent.search(NON_SPACE_RE) >= indent || !rawLine.trim()) {
          content += '\n' + lineContent.slice(indent);
        } else {
          if (
            blank ||
            itemLine.replace(/\t/g, '    ').search(NON_SPACE_RE) >= 4 ||
            fencesRe.test(itemLine) ||
            headingRe.test(itemLine) ||
            htmlRe.test(itemLine) ||
            hrRe.test(itemLine)
          ) {
            break;
          }
          const addLine =
            /^ {0,3}(?:=+|-+) *$/.test(rawLine) && LHEAD.test(itemLine + '\n' + rawLine)
              ? '    ' + lineContent.replace(/^ {0,3}/, '')
              : rawLine;
          content += '\n' + addLine;
        }
        blank = !rawLine.trim();
        p += rawLine.length + 1;
        itemLine = lineContent.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, p);
    if (!list.loose) {
      if (endNextLineBlank) list.loose = true;
      else if (DOUBLE_BLANK_RE.test(itemRaw)) endNextLineBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: IS_TASK_RE.test(content),
      loose: false,
      text: content,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = src.slice(start, p).trimEnd();
  for (const item of list.items) {
    ST.top = false;
    item.tokens = tokenizeBlocks(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => ANY_LINE_RE.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(TASK_PREFIX_RE, '');
      first.raw = first.raw.replace(TASK_PREFIX_RE, '');
      first.text = first.text.replace(TASK_PREFIX_RE, '');
      for (let g = JOBS.length - 1; g >= 0; g--) {
        if (IS_TASK_RE.test(JOBS[g].src)) {
          JOBS[g].src = JOBS[g].src.replace(TASK_PREFIX_RE, '');
          break;
        }
      }
      const checkboxCap = TASK_BOX_RE.exec(item.raw);
      if (checkboxCap) {
        const checkbox = { type: 'checkbox', raw: checkboxCap[0] + ' ', checked: checkboxCap[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function tryHtml(src, pos) {
  const cap = execAtPos(HTML_Y, src, pos);
  if (!cap) return undefined;
  const raw = trimCodeTail(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function tryDef(src, pos) {
  const cap = execAtPos(DEF_Y, src, pos);
  if (!cap) return undefined;
  if (!ANGLE_OPEN_RE.test(cap[2]) && findCloseDelim(cap[2], '()') !== -1) return undefined;
  const tag = normRef(cap[1]);
  const href = cap[2] ? cap[2].replace(HREF_ANGLE_RE, '$1').replace(IN_ANY_PUNCT, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(IN_ANY_PUNCT, '$1') : cap[3];
  return { type: 'def', tag, raw: stripTrail(cap[0], '\n'), href, title };
}

function tryTable(src, pos) {
  const cap = execAtPos(TABLE_Y, src, pos);
  if (!cap || !TABLE_DELIM_RE.test(cap[2])) return undefined;
  const headerCells = splitRow(cap[1]);
  const delims = cap[2].replace(TABLE_ALIGN_TRIM_RE, '').split('|');
  const rowLines = cap[3]?.trim() ? cap[3].replace(ROW_TRAIL_BLANK_RE, '').split('\n') : [];
  if (headerCells.length !== delims.length) return undefined;
  const table = { type: 'table', raw: stripTrail(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of delims) {
    if (ALIGN_RIGHT_RE.test(cell)) table.align.push('right');
    else if (ALIGN_CENTER_RE.test(cell)) table.align.push('center');
    else if (ALIGN_LEFT_RE.test(cell)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: deferInline(headerCells[i]), header: true, align: table.align[i] });
  }
  for (const row of rowLines) {
    table.rows.push(
      splitRow(row, table.header.length).map((cell, j) => ({
        text: cell,
        tokens: deferInline(cell),
        header: false,
        align: table.align[j],
      })),
    );
  }
  return table;
}

function trySetext(src, pos) {
  const cap = execAtPos(LHEAD_Y, src, pos);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: stripTrail(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: deferInline(text),
  };
}

function tryPara(src, pos) {
  const cap = execAtPos(PARA_Y, src, pos);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: deferInline(text) };
}

function tryTextBlock(src, pos) {
  const cap = execAtPos(TEXT_Y, src, pos);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], tokens: deferInline(cap[0]) };
}

// Cheap necessary-condition gate for the table rule: a header line, then a delimiter line.
function mayBeTable(src, pos) {
  const line1End = src.indexOf('\n', pos);
  if (line1End === -1) return false;
  const line2Start = line1End + 1;
  let line2End = src.indexOf('\n', line2Start);
  if (line2End === -1) line2End = src.length;
  let i = line2Start;
  let spaces = 0;
  while (i < line2End && src[i] === ' ' && spaces < 4) {
    i++;
    spaces++;
  }
  if (spaces > 3) return false;
  let hasDash = false;
  let hasPipeOrColon = false;
  let any = false;
  for (; i < line2End; i++) {
    const ch = src[i];
    if (ch === '-') hasDash = true;
    else if (ch === '|' || ch === ':') hasPipeOrColon = true;
    else if (ch !== ' ') return false;
    any = true;
  }
  return any && hasDash && hasPipeOrColon;
}

// Cheap necessary-condition gate for the setext rule: an underline line before any blank line.
const SETEXT_UL_RE = /^ {0,3}(=+|-+)[ \t]*$/;
function mayBeSetext(src, pos) {
  let i = pos;
  let first = true;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? src.length : nl;
    if (!first) {
      const line = src.slice(i, lineEnd);
      if (SETEXT_UL_RE.test(line)) return true;
      if (BLANK_LINE_RE.test(line)) return false;
    }
    first = false;
    if (nl === -1) break;
    i = nl + 1;
  }
  return false;
}

/* ------------------------------------------------------------ block loop */

function tokenizeBlocks(src, tokens, inBlockquote = false) {
  let n = inBlockquote;
  let pos = 0;
  let lastRemaining = Infinity;
  const len = src.length;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining < lastRemaining) lastRemaining = remaining;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let tok;
    const spaceCap = execAtPos(NL_Y, src, pos);
    if (spaceCap) {
      pos += spaceCap[0].length;
      const last = tokens[tokens.length - 1];
      if (spaceCap[0].length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push({ type: 'space', raw: spaceCap[0] });
      continue;
    }
    const c0 = src[pos];
    if ((c0 === ' ' || c0 === '\t') && (tok = tryCode(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        JOBS[JOBS.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    // First non-space character within the next 3 columns, for construct gating.
    let gi = pos;
    let gsp = 0;
    while (gsp < 3 && src[gi] === ' ') {
      gi++;
      gsp++;
    }
    const gc = src[gi];
    if ((gc === '`' || gc === '~') && (tok = tryFence(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '#' && (tok = tryHeading(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if ((gc === '-' || gc === '_' || gc === '*') && (tok = tryHr(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '>' && (tok = tryQuote(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if ((gc === '*' || gc === '+' || gc === '-' || (gc >= '0' && gc <= '9')) && (tok = tryList(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '<' && (tok = tryHtml(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '[' && (tok = tryDef(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        JOBS[JOBS.length - 1].src = last.text;
      } else {
        if (!REFS[tok.tag]) REFS[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (mayBeTable(src, pos) && (tok = tryTable(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (mayBeSetext(src, pos) && (tok = trySetext(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (ST.top && (tok = tryPara(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (n && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        JOBS.pop();
        JOBS[JOBS.length - 1].src = last.text;
      } else tokens.push(tok);
      n = false;
      continue;
    }
    tok = tryTextBlock(src, pos);
    if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += tok.raw.length;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') {
      last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      last.text += '\n' + tok.text;
      JOBS.pop();
      JOBS[JOBS.length - 1].src = last.text;
    } else tokens.push(tok);
  }
  ST.top = true;
  return tokens;
}

/* ------------------------------------------------------------ renderer */

function renderTextTok(token, textMode) {
  if (textMode) return token.text;
  return token.tokens ? renderInlineToks(token.tokens, false) : token.escaped ? token.text : escHtml(token.text);
}

function renderInlineToks(tokens, textMode) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += textMode ? token.text : escHtml(token.text);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link': {
        if (textMode) {
          out += token.tokens ? renderInlineToks(token.tokens, true) : token.text;
          break;
        }
        const inner = token.autolink ? escHtml(token.text, true) : renderInlineToks(token.tokens, false);
        const href = tidyUrl(token.href);
        if (href === null) {
          out += inner;
          break;
        }
        let tag = '<a href="' + escHtml(href, token.autolink) + '"';
        if (token.title) tag += ' title="' + escHtml(token.title) + '"';
        out += tag + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = token.tokens ? renderInlineToks(token.tokens, true) : token.text;
        if (textMode) {
          out += alt;
          break;
        }
        const href = tidyUrl(token.href);
        if (href === null) {
          out += escHtml(alt);
          break;
        }
        let tag = '<img src="' + escHtml(href) + '" alt="' + escHtml(alt) + '"';
        if (token.title) tag += ' title="' + escHtml(token.title) + '"';
        out += tag + '>';
        break;
      }
      case 'checkbox':
        out += textMode ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += textMode ? renderInlineToks(token.tokens, true) : '<strong>' + renderInlineToks(token.tokens, false) + '</strong>';
        break;
      case 'em':
        out += textMode ? renderInlineToks(token.tokens, true) : '<em>' + renderInlineToks(token.tokens, false) + '</em>';
        break;
      case 'codespan':
        out += textMode ? token.text : '<code>' + escHtml(token.text, true) + '</code>';
        break;
      case 'br':
        out += textMode ? '' : '<br>';
        break;
      case 'del':
        out += textMode ? renderInlineToks(token.tokens, true) : '<del>' + renderInlineToks(token.tokens, false) + '</del>';
        break;
      case 'text':
        out += renderTextTok(token, textMode);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderCodeBlock(token) {
  const firstWord = (token.lang || '').match(/^\S*/)?.[0];
  const text = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  if (firstWord) {
    return '<pre><code class="language-' + escHtml(firstWord) + '">' + escHtml(text, true) + '</code></pre>\n';
  }
  return '<pre><code>' + escHtml(text, true) + '</code></pre>\n';
}

function renderTableBlock(token) {
  let headerHtml = '';
  for (const cell of token.header) headerHtml += renderCell(cell);
  let out = '<table>\n<thead>\n' + '<tr>\n' + headerHtml + '</tr>\n' + '</thead>\n';
  let body = '';
  for (const row of token.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderCell(cell);
    body += '<tr>\n' + rowHtml + '</tr>\n';
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  return out + '</table>\n';
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInlineToks(cell.tokens, false) + `</${tag}>\n`;
}

function renderListBlock(token) {
  let items = '';
  for (const item of token.items) items += '<li>' + renderBlockToks(item.tokens) + '</li>\n';
  const tag = token.ordered ? 'ol' : 'ul';
  const start = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderBlockToks(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + token.depth + '>' + renderInlineToks(token.tokens, false) + '</h' + token.depth + '>\n';
        break;
      case 'code':
        out += renderCodeBlock(token);
        break;
      case 'table':
        out += renderTableBlock(token);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlockToks(token.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderListBlock(token);
        break;
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInlineToks(token.tokens, false) + '</p>\n';
        break;
      case 'text':
        out += renderTextTok(token, false);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

/* ------------------------------------------------------------ entry point */

const CR_RE = /\r\n|\r/g;

export function parse(markdown) {
  REFS = Object.create(null);
  JOBS = [];
  ST.inLink = false;
  ST.inRawBlock = false;
  ST.linkEmitted = false;
  ST.linkParenPossible = true;
  ST.top = true;
  const src = markdown.replace(CR_RE, '\n');
  const tokens = [];
  tokenizeBlocks(src, tokens);
  for (let i = 0; i < JOBS.length; i++) {
    const entry = JOBS[i];
    ST.inRawBlock = false;
    tokenizeInline(entry.src, entry.tokens);
  }
  JOBS = [];
  return renderBlockToks(tokens);
}

