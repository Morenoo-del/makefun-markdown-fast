// A fast, dependency-free drop-in replacement for marked 18.1.3 (default options, GFM on).
// parse(markdown) returns exactly the HTML string marked returns, byte for byte.
//
// The implementation follows marked's semantics rule for rule (block lexer -> tokens ->
// inline lexer -> renderer), but scans with an index into the source string and sticky
// regexes instead of marked's slice-the-remainder approach, and replaces the masking
// passes marked runs before emphasis parsing with equivalent hand-written scanners.

/* ------------------------------------------------------------------ helpers */

const escapeReplacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(text, encode) {
  if (encode) {
    if (escapeTest.test(text)) return text.replace(escapeReplace, (ch) => escapeReplacements[ch]);
  } else if (escapeTestNoEncode.test(text)) {
    return text.replace(escapeReplaceNoEncode, (ch) => escapeReplacements[ch]);
  }
  return text;
}

const numericRefTest = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** marked's unescape: decodes numeric character references, leaves named ones alone. */
function decodeNumericRefs(text) {
  if (!text.includes('&') || !numericRefTest.test(text)) return text;
  return text.replace(numericRefOrAmp, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** marked's cleanUrl: encodeURI, undoing %25; null when encodeURI throws. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** marked's splitCells for table rows. */
function splitCells(tableRow, count) {
  const cells = tableRow
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

/** marked's rtrim: strip trailing runs of `ch`. */
function rtrim(str, ch) {
  const n = str.length;
  let s = 0;
  while (s < n && str.charAt(n - s - 1) === ch) s++;
  return s === 0 ? str : str.slice(0, n - s);
}

/** marked's trimCode: drop trailing blank lines of an indented code block (keeps at most one). */
const blankLineRe = /^[ \t]*$/;
function trimCode(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && blankLineRe.test(lines[t])) t--;
  return lines.length - t <= 2 ? text : lines.slice(0, t + 1).join('\n');
}

/** marked's label normalization for link references. */
function normalizeLabel(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** marked's findClosingDelimiter: index of the unbalanced closer, -2 if unclosed, -1 if none/balanced. */
function findClosingDelimiter(text, pair) {
  if (text.indexOf(pair[0]) === -1 && text.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < text.length; n++) {
    if (text[n] === '\\') n++;
    else if (text[n] === pair[0]) depth++;
    else if (text[n] === pair[1] && (depth--, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

/** marked's unindent: expand tabs to 4-column stops starting at column `startCol`. */
function expandTabs(str, startCol = 0) {
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

const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpaceRe = /^\s+/;
/** marked's getNextLineIndent / indent compensation for fenced code content. */
function indentCompensation(raw, text) {
  const match = raw.match(indentCodeCompensationRe);
  if (match === null) return text;
  const indent = match[1];
  return text
    .split('\n')
    .map((line) => {
      const space = line.match(beginningSpaceRe);
      if (space === null) return line;
      return line.slice(Math.min(space[0].length, indent.length));
    })
    .join('\n');
}

/* ------------------------------------------------------------------ rules */

// Sticky twins of marked's anchored rules: same pattern, but every top-level ^ anchor
// (the start of the pattern or of an alternative) is dropped and the 'y' flag added, so a
// rule can be matched at an index in a longer string. ^ inside groups or classes is kept:
// marked's substring matches anchor those at the substring start too only when the group
// is entered at position 0, and the rules used with sticky matching have none.
function sticky(re) {
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
function execAt(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockNewlineY = sticky(blockNewline);
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockCodeY = sticky(blockCode);
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockFencesY = sticky(blockFences);
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const blockHeadingY = sticky(blockHeading);
const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const blockHrY = sticky(blockHr);
const blockBlockquote = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;
const blockBlockquoteY = sticky(blockBlockquote);
const blockList = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const blockListY = sticky(blockList);
const blockHtml = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const blockHtmlY = sticky(blockHtml);
const blockDef = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const blockDefY = sticky(blockDef);
const blockTable = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const blockTableY = sticky(blockTable);
const blockLheading = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const blockLheadingY = sticky(blockLheading);
const blockParagraph = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const blockParagraphY = sticky(blockParagraph);
const blockText = /^[^\n]+/;
const blockTextY = sticky(blockText);

// "other" rules (marked's T table), used on substrings exactly as marked uses them.
const codeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplace = /\\([\[\]])/g;
const endingHash = /#$/;
const endingSpaceTabChar = /[ \t]$/;
const nonSpaceChar = /[^ ]/;
const leadingSpaceTab = /^[ \t]+/;
const doubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const blockquoteStart = /^ {0,3}>/;
const blockquoteSetextReplace = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2 = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespace = /^( {0,3}>)([ \t]+)/gm;
const listIsTask = /^\[[ xX]\][ \t]+\S/;
const listReplaceTask = /^\[[ xX]\][ \t]+/;
const listTaskCheckbox = /\[[ xX]\]/;
const anyLine = /\n.*\n/;
const hrefBrackets = /^<(.*)>$/;
const tableDelimiter = /[:|]/;
const tableAlignChars = /^\||\| *$/g;
const tableRowBlankLine = /\n[ \t]*$/;
const tableAlignRight = /^ *-+: *$/;
const tableAlignCenter = /^ *:-+: *$/;
const tableAlignLeft = /^ *:-+ *$/;
const startATag = /^<a /i;
const endATag = /^<\/a>/i;
const startPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracket = /^</;
const endAngleBracket = />$/;
const unicodeAlphaNumeric = /[\p{L}\p{N}]/u;

function listItemRegex(bullet) {
  return new RegExp(`( {0,3}${bullet})((?:[ \\t][^\\n]*)?(?:\\n|$))`, 'y');
}
// marked caches these "begin" regexes through a clamp: the variant used for indent R is
// the one built for clamp(R-1, 0, 3).
function clampIndent(r) {
  return Math.max(0, Math.min(3, r - 1));
}
const nextBulletRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrBeginRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRes = [0, 1, 2, 3].map((a) => new RegExp(`^ {0,${a}}>`));

// inline rules (GFM set)
const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineEscapeY = sticky(inlineEscape);
const inlineTag = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const inlineTagY = sticky(inlineTag);
const inlineLink = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const inlineLinkY = sticky(inlineLink);
const inlineReflink = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const inlineReflinkY = sticky(inlineReflink);
const inlineNolink = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const inlineNolinkY = sticky(inlineNolink);
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineCodeY = sticky(inlineCode);
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlineBrY = sticky(inlineBr);
const inlineAutolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const inlineAutolinkY = sticky(inlineAutolink);
const inlineUrl = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const inlineUrlY = sticky(inlineUrl);
const inlineText = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const inlineTextY = sticky(inlineText);
const inlinePunctuation = /^((?![*_])[\s\p{P}\p{S}])/u;
const inlineAnyPunctuation = /\\([\p{P}\p{S}])/gu;
const inlineEmStrongLDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const inlineEmStrongLDelimY = sticky(inlineEmStrongLDelim);
const inlineEmStrongRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const inlineEmStrongRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const inlineDelLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const inlineDelLDelimY = sticky(inlineDelLDelim);
const inlineDelRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const inlineBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const inlineReflinkSearch = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const blockSkipLink = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/;
const blockSkipLinkY = sticky(blockSkipLink);
const blockSkipCode = /(?<b>`+)[^`]+\k<b>(?!`)/;
const blockSkipCodeY = sticky(blockSkipCode);
const blockSkipHtml = /<(?! )[^<>]*?>/;
const blockSkipHtmlY = sticky(blockSkipHtml);

/* ------------------------------------------------------------------ lexer state */

let links = Object.create(null);
let inlineQueue = [];
const state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };

function queueInline(text) {
  const tokens = [];
  inlineQueue.push({ src: text, tokens });
  return tokens;
}

/* ------------------------------------------------------- masking (marked's #n) */

const blockSkipAll = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(blockSkipAll)) {
    if (inlineLink.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inlineReflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

function maskReflinkCallback(r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner)) {
      return '[' + inner.replace(inlineReflinkSearch, maskReflinkCallback) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

const anyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

/** Stage 2 of the mask: marked's anyPunctuationOutsideCode replace, verbatim semantics. */
function maskEscapesAndCode(s) {
  if (!s.includes('\\') && !s.includes('`')) return s;
  return s.replace(anyPunctuationOutsideCode, (n, run, esc) =>
    esc
      ? '+'.repeat(n.length)
      : run
        ? run + n.slice(run.length, -run.length).replace(/`/g, '+') + run
        : n,
  );
}

/** Stage 3 of the mask: marked's blockSkip replace, verbatim semantics. */
function maskBlockSkip(s) {
  if (!s.includes('[') && !s.includes('`') && !s.includes('<')) return s;
  return s.replace(blockSkipAll, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
}

function maskSrc(src) {
  let t = src;
  if (t.includes('[')) t = t.replace(inlineReflinkSearch, maskReflinkCallback);
  t = maskEscapesAndCode(t);
  t = maskBlockSkip(t);
  return t;
}

const delimRunRe = /([*_~])\1*/g;

/** marked's findLastPossibleCloser scan over the masked source. */
function computeClosers(masked) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  delimRunRe.lastIndex = 0;
  let m;
  while ((m = delimRunRe.exec(masked)) !== null) {
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

/* ------------------------------------------------------------------ inline tokenizers */

function escapeAt(src, pos) {
  const cap = execAt(inlineEscapeY, src, pos);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  return undefined;
}

function tagAt(src, pos) {
  const cap = execAt(inlineTagY, src, pos);
  if (!cap) return undefined;
  if (!state.inLink && startATag.test(cap[0])) state.inLink = true;
  else if (state.inLink && endATag.test(cap[0])) state.inLink = false;
  if (!state.inRawBlock && startPreScriptTag.test(cap[0])) state.inRawBlock = true;
  else if (state.inRawBlock && endPreScriptTag.test(cap[0])) state.inRawBlock = false;
  return { type: 'html', raw: cap[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: cap[0] };
}

/** marked's checkLinkTextForNestedTag (the `Be` helper). */
function linkTextHasNestedTag(src, pos, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const cap = execAt(inlineCodeY, label, s);
      if (cap) {
        s += cap[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(pos + offset + s);
    const cap = inlineTag.exec(rest) || inlineAutolink.exec(rest);
    if (cap) {
      if (cap[0].length > label.length - s) return true;
      s += cap[0].length - 1;
    }
  }
  return false;
}

function outputLink(cap, href, title, raw) {
  const text = cap[1].replace(outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  const savedRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const tokens = inlineTokens(text, []);
  const emitted = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      state.inRawBlock = savedRawBlock;
      return undefined;
    }
    state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

function linkAt(src, pos) {
  if (state.linkParenPossible === false) return undefined;
  const cap = execAt(inlineLinkY, src, pos);
  if (!cap) return undefined;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasNestedTag(src, pos, cap[1], offset)) return undefined;
  let href = cap[2].trim();
  if (startAngleBracket.test(href)) {
    if (!endAngleBracket.test(href)) return undefined;
    const trimmed = rtrim(href.slice(0, -1), '\\');
    if ((href.length - trimmed.length) % 2 === 0) return undefined;
  } else {
    const balance = findClosingDelimiter(cap[2], '()');
    if (balance === -2) return undefined;
    if (balance > -1) {
      const h = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + balance;
      cap[2] = cap[2].substring(0, balance);
      cap[0] = cap[0].substring(0, h).trim();
      cap[3] = '';
    }
  }
  const trimmedRaw = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - trimmedRaw.length) % 2 === 0) return undefined;
  let outHref = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  outHref = outHref.trim();
  if (startAngleBracket.test(outHref)) outHref = outHref.slice(1, -1);
  return outputLink(
    cap,
    outHref ? outHref.replace(inlineAnyPunctuation, '$1') : outHref,
    title ? title.replace(inlineAnyPunctuation, '$1') : title,
    cap[0],
  );
}

function reflinkAt(src, pos) {
  const cap = execAt(inlineReflinkY, src, pos) || execAt(inlineNolinkY, src, pos);
  if (!cap) return undefined;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasNestedTag(src, pos, cap[1], offset)) return undefined;
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return outputLink(cap, link.href, link.title, cap[0]);
}

/**
 * marked's [...cap[0]].length - 1 for an LDelim match: an ASCII delimiter run plus at
 * most one trailing code point, counted in code points, not UTF-16 units.
 */
function delimOpenerLen(cap0) {
  let n = cap0.length - 1;
  if (cap0.length >= 2) {
    const lastCc = cap0.charCodeAt(cap0.length - 1);
    const prevCc = cap0.charCodeAt(cap0.length - 2);
    if (lastCc >= 0xdc00 && lastCc <= 0xdfff && prevCc >= 0xd800 && prevCc <= 0xdbff) n--;
  }
  return n;
}

/** UTF-16 length of the first code point of s (marked's [...s][0].length). */
function firstCodePointLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) {
    const c2 = s.charCodeAt(1);
    if (c2 >= 0xdc00 && c2 <= 0xdfff) return 2;
  }
  return 1;
}

function emStrongAt(src, pos, masked, closers, prevChar) {
  // No possible closer at or before pos means the LDelim exec cannot succeed usefully:
  // marked's v >= Q check would reject with Q >= pos, and v === pos forces k === 0,
  // which means no delimiter group, an earlier return in marked as well.
  if (closers.lastEmStrong[src[pos]] <= pos) return undefined;
  const cap = execAt(inlineEmStrongLDelimY, src, pos);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delim = cap[0][0];
  const onlySame = prevChar === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const prevPoint = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const prevIsPunct = prevPoint === '*' || prevPoint === '_' || !!inlinePunctuation.exec(prevPoint);
  const effPrev = l < i ? prevPoint : prevChar;
  const punctCond = l < i ? prevIsPunct : !!inlinePunctuation.exec(effPrev);
  if (cap[4] && unicodeAlphaNumeric.test(effPrev)) return undefined;
  const afterPunct = cap[1] || cap[3] || '';
  if (!afterPunct || !effPrev || punctCond) {
    const openerLen = delimOpenerLen(cap[0]);
    let m = openerLen;
    let f = 0;
    const y = i - l + openerLen;
    const ruleOfThree = !!prevPoint.trim() && (!!afterPunct || (delim === '*' && !prevIsPunct));
    const rule = delim === '*' ? inlineEmStrongRDelimAst : inlineEmStrongRDelimUnd;
    const lastCloser = closers.lastEmStrong[delim];
    const start = i + openerLen;
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
      const firstCpLen = firstCodePointLen(rcap[0]);
      const raw = src.slice(pos, pos + openerLen + rcap.index + firstCpLen + b);
      if (Math.min(openerLen, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text, []) };
    }
  }
  return undefined;
}

function codespanAt(src, pos) {
  const cap = execAt(inlineCodeY, src, pos);
  if (!cap) return undefined;
  let text = cap[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(text);
  const hasSpaceEdges = /^ /.test(text) && / $/.test(text);
  if (hasNonSpace && hasSpaceEdges) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function brAt(src, pos) {
  const cap = execAt(inlineBrY, src, pos);
  if (cap) return { type: 'br', raw: cap[0] };
  return undefined;
}

function delAt(src, pos, masked, closers, prevChar) {
  if (closers.lastDel <= pos) return undefined;
  const cap = execAt(inlineDelLDelimY, src, pos);
  if (!cap) return undefined;
  if (!(cap[1] || '') || !prevChar || inlinePunctuation.exec(prevChar)) {
    const openerLen = delimOpenerLen(cap[0]);
    let openers = openerLen;
    const lastCloser = closers.lastDel;
    const start = pos + openerLen;
    if (lastCloser < start) return undefined;
    const rest = masked.slice(start);
    const limit = lastCloser - start;
    const rule = inlineDelRDelim;
    rule.lastIndex = 0;
    let rcap;
    while ((rcap = rule.exec(rest)) !== null && !(rcap.index > limit)) {
      const g = rcap[1] || rcap[2] || rcap[3] || rcap[4] || rcap[5] || rcap[6];
      if (!g) continue;
      let runLen = g.length; // g is a run of ASCII tildes
      if (runLen !== openerLen) continue;
      if (rcap[3] || rcap[4]) {
        openers += runLen;
        continue;
      }
      openers -= runLen;
      if (openers > 0) continue;
      runLen = Math.min(runLen, runLen + openers);
      const firstCpLen = firstCodePointLen(rcap[0]);
      const raw = src.slice(pos, pos + openerLen + rcap.index + firstCpLen + runLen);
      const text = raw.slice(openerLen, raw.length - openerLen);
      return { type: 'del', raw, text, tokens: inlineTokens(text, []) };
    }
  }
  return undefined;
}

function autolinkAt(src, pos) {
  const cap = execAt(inlineAutolinkY, src, pos);
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

/**
 * Exact pre-filter for urlAt: the url rule can only match when the maximal run of
 * email-local characters at pos is followed by '@' (bare email) or '://' (protocol),
 * or the text at pos starts with 'www.', 'mailto:' or 'xmpp:'. No false negatives.
 */
function urlPossible(src, pos) {
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

function urlAt(src, pos) {
  if (!urlPossible(src, pos)) return undefined;
  const cap = execAt(inlineUrlY, src, pos);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = inlineBackpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function inlineTextAt(src, pos) {
  const cap = execAt(inlineTextY, src, pos);
  if (!cap) return undefined;
  const inRaw = state.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumericRefs(cap[0]), escaped: inRaw };
}

/** Chars a GFM url token (protocol, www., mailto/xmpp, or bare email) can start with. */
function isUrlStartCode(c) {
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

function inlineTokens(src, tokens = []) {
  const saved = state.linkParenPossible;
  state.linkParenPossible = saved && src.includes(')');
  const out = inlineTokensInner(src, tokens);
  state.linkParenPossible = saved;
  return out;
}

const delimCharRe = /[*_~]/;
function inlineTokensInner(src, tokens) {
  let masked = src;
  if (delimCharRe.test(src)) masked = maskSrc(src);
  const closers = computeClosers(masked);
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
      tok = escapeAt(src, pos) || brAt(src, pos);
    } else if (c === 60) {
      // <: tag, then autolink
      tok = tagAt(src, pos) || autolinkAt(src, pos);
    } else if (c === 91 || c === 33) {
      // [ or !: link, then reflink (whose text result merges like marked's)
      tok = linkAt(src, pos);
      if (!tok) {
        tok = reflinkAt(src, pos);
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
      tok = emStrongAt(src, pos, masked, closers, prevChar);
    } else if (c === 96) {
      tok = codespanAt(src, pos);
    } else if (c === 126) {
      tok = delAt(src, pos, masked, closers, prevChar);
    } else if (c === 32) {
      tok = brAt(src, pos);
    }
    if (!tok && !state.inLink && isUrlStartCode(c)) tok = urlAt(src, pos);
    if (tok) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    tok = inlineTextAt(src, pos);
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

/* ------------------------------------------------------------------ block tokenizers */

function codeAt(src, pos) {
  const cap = execAt(blockCodeY, src, pos);
  if (!cap) return undefined;
  const raw = trimCode(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(codeRemoveIndent, '') };
}

function fencesAt(src, pos) {
  const cap = execAt(blockFencesY, src, pos);
  if (!cap) return undefined;
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(inlineAnyPunctuation, '$1') : cap[2],
    text: indentCompensation(cap[0], cap[3] || ''),
  };
}

function headingAt(src, pos) {
  const cap = execAt(blockHeadingY, src, pos);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(text) };
}

function hrAt(src, pos) {
  const cap = execAt(blockHrY, src, pos);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
  return undefined;
}

function blockquoteAt(src, pos) {
  const cap = execAt(blockBlockquoteY, src, pos);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(blockquoteMarkerWhitespace, (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(blockquoteSetextReplace, '\n    $1')
      .replace(blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const savedTop = state.top;
    state.top = true;
    blockTokens(chunkText, tokens, true);
    state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const rest = lines.join('\n').replace(blockquoteSetextReplace2, '');
      const mergedSrc = last.raw + '\n' + rest;
      const merged = blockquoteAt(mergedSrc, 0);
      tokens[tokens.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const mergedSrc = last.raw + '\n' + lines.join('\n');
      const merged = listAt(mergedSrc, 0);
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

/** line.replace(leadingSpaceTab, s => expandTabs(s, startCol)) without the regex when tab-free. */
function expandLeadingTabs(line, startCol) {
  let i = 0;
  const n = line.length;
  let hasTab = false;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') hasTab = true;
    i++;
  }
  if (i === 0 || !hasTab) return line;
  return expandTabs(line.slice(0, i), startCol) + line.slice(i);
}

/** Chars that can start a block interrupting a list item (fences/heading/html/quote/bullet/hr). */
function isBeginCandidate(c) {
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

function listAt(src, pos) {
  const cap = execAt(blockListY, src, pos);
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
  const itemRe = listItemRegex(bull);
  let endNextLineBlank = false;
  while (p < src.length) {
    let itemStartsBlank = false;
    const itemCap = execAt(itemRe, src, p);
    if (!itemCap || execAt(blockHrY, src, p)) break;
    const itemStart = p;
    p += itemCap[0].length;
    const cap2 = itemCap[2];
    const nl2 = cap2.indexOf('\n');
    const line = nl2 === -1 ? cap2 : cap2.slice(0, nl2);
    const bulletLen = itemCap[1].length;
    let itemLine = expandLeadingTabs(line, bulletLen);
    let nextLine = firstLine();
    let blank = !itemLine.trim();
    let indent = 0;
    let content = '';
    if (blank) {
      indent = bulletLen + 1;
    } else {
      indent = itemLine.search(nonSpaceChar);
      if (indent > 4) indent = 1;
      content = itemLine.slice(indent);
      indent += bulletLen;
    }
    if (blank && blankLineRe.test(nextLine)) {
      p += nextLine.length + 1;
      itemStartsBlank = true;
    }
    if (!itemStartsBlank) {
      const ci = clampIndent(indent);
      const nextBulletRe = nextBulletRes[ci];
      const hrRe = hrBeginRes[ci];
      const fencesRe = fencesBeginRes[ci];
      const headingRe = headingBeginRes[ci];
      const htmlRe = htmlBeginRes[ci];
      const quoteRe = blockquoteBeginRes[ci];
      while (p < src.length) {
        const rawLine = firstLine();
        nextLine = rawLine;
        const lineContent = expandLeadingTabs(rawLine, 0);
        let gi = 0;
        while (gi < rawLine.length && (rawLine[gi] === ' ' || rawLine[gi] === '\t')) gi++;
        if (
          isBeginCandidate(rawLine.charCodeAt(gi)) &&
          (fencesRe.test(rawLine) ||
            headingRe.test(rawLine) ||
            htmlRe.test(rawLine) ||
            quoteRe.test(rawLine) ||
            nextBulletRe.test(rawLine) ||
            hrRe.test(rawLine))
        ) {
          break;
        }
        if (lineContent.search(nonSpaceChar) >= indent || !rawLine.trim()) {
          content += '\n' + lineContent.slice(indent);
        } else {
          if (
            blank ||
            itemLine.replace(/\t/g, '    ').search(nonSpaceChar) >= 4 ||
            fencesRe.test(itemLine) ||
            headingRe.test(itemLine) ||
            htmlRe.test(itemLine) ||
            hrRe.test(itemLine)
          ) {
            break;
          }
          const addLine =
            /^ {0,3}(?:=+|-+) *$/.test(rawLine) && blockLheading.test(itemLine + '\n' + rawLine)
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
      else if (doubleBlankLine.test(itemRaw)) endNextLineBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: listIsTask.test(content),
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
    state.top = false;
    item.tokens = blockTokens(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => anyLine.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(listReplaceTask, '');
      first.raw = first.raw.replace(listReplaceTask, '');
      first.text = first.text.replace(listReplaceTask, '');
      for (let g = inlineQueue.length - 1; g >= 0; g--) {
        if (listIsTask.test(inlineQueue[g].src)) {
          inlineQueue[g].src = inlineQueue[g].src.replace(listReplaceTask, '');
          break;
        }
      }
      const checkboxCap = listTaskCheckbox.exec(item.raw);
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

function htmlAt(src, pos) {
  const cap = execAt(blockHtmlY, src, pos);
  if (!cap) return undefined;
  const raw = trimCode(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function defAt(src, pos) {
  const cap = execAt(blockDefY, src, pos);
  if (!cap) return undefined;
  if (!startAngleBracket.test(cap[2]) && findClosingDelimiter(cap[2], '()') !== -1) return undefined;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(hrefBrackets, '$1').replace(inlineAnyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inlineAnyPunctuation, '$1') : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tableAt(src, pos) {
  const cap = execAt(blockTableY, src, pos);
  if (!cap || !tableDelimiter.test(cap[2])) return undefined;
  const headerCells = splitCells(cap[1]);
  const delims = cap[2].replace(tableAlignChars, '').split('|');
  const rowLines = cap[3]?.trim() ? cap[3].replace(tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== delims.length) return undefined;
  const table = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of delims) {
    if (tableAlignRight.test(cell)) table.align.push('right');
    else if (tableAlignCenter.test(cell)) table.align.push('center');
    else if (tableAlignLeft.test(cell)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(headerCells[i]), header: true, align: table.align[i] });
  }
  for (const row of rowLines) {
    table.rows.push(
      splitCells(row, table.header.length).map((cell, j) => ({
        text: cell,
        tokens: queueInline(cell),
        header: false,
        align: table.align[j],
      })),
    );
  }
  return table;
}

function lheadingAt(src, pos) {
  const cap = execAt(blockLheadingY, src, pos);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(text),
  };
}

function paragraphAt(src, pos) {
  const cap = execAt(blockParagraphY, src, pos);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(text) };
}

function textAt(src, pos) {
  const cap = execAt(blockTextY, src, pos);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(cap[0]) };
}

/** Cheap necessary-condition gate for the table rule: a header line, then a delimiter line. */
function tableGate(src, pos) {
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

/** Cheap necessary-condition gate for the setext (lheading) rule: an underline line before any blank line. */
const setextUnderline = /^ {0,3}(=+|-+)[ \t]*$/;
function lheadingGate(src, pos) {
  let i = pos;
  let first = true;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? src.length : nl;
    if (!first) {
      const line = src.slice(i, lineEnd);
      if (setextUnderline.test(line)) return true;
      if (blankLineRe.test(line)) return false;
    }
    first = false;
    if (nl === -1) break;
    i = nl + 1;
  }
  return false;
}

/* ------------------------------------------------------------------ block loop */

function blockTokens(src, tokens, inBlockquote = false) {
  let n = inBlockquote;
  let pos = 0;
  let lastRemaining = Infinity;
  const len = src.length;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining < lastRemaining) lastRemaining = remaining;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let tok;
    const spaceCap = execAt(blockNewlineY, src, pos);
    if (spaceCap) {
      pos += spaceCap[0].length;
      const last = tokens[tokens.length - 1];
      if (spaceCap[0].length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push({ type: 'space', raw: spaceCap[0] });
      continue;
    }
    const c0 = src[pos];
    if ((c0 === ' ' || c0 === '\t') && (tok = codeAt(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        inlineQueue[inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    // first non-space character within the next 3 columns, for construct gating
    let gi = pos;
    let gsp = 0;
    while (gsp < 3 && src[gi] === ' ') {
      gi++;
      gsp++;
    }
    const gc = src[gi];
    if ((gc === '`' || gc === '~') && (tok = fencesAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '#' && (tok = headingAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if ((gc === '-' || gc === '_' || gc === '*') && (tok = hrAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '>' && (tok = blockquoteAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if ((gc === '*' || gc === '+' || gc === '-' || (gc >= '0' && gc <= '9')) && (tok = listAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '<' && (tok = htmlAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (gc === '[' && (tok = defAt(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        inlineQueue[inlineQueue.length - 1].src = last.text;
      } else {
        if (!links[tok.tag]) links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (tableGate(src, pos) && (tok = tableAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (lheadingGate(src, pos) && (tok = lheadingAt(src, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }
    if (state.top && (tok = paragraphAt(src, pos))) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (n && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        inlineQueue.pop();
        inlineQueue[inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      n = false;
      continue;
    }
    tok = textAt(src, pos);
    if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += tok.raw.length;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') {
      last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      last.text += '\n' + tok.text;
      inlineQueue.pop();
      inlineQueue[inlineQueue.length - 1].src = last.text;
    } else tokens.push(tok);
  }
  state.top = true;
  return tokens;
}

/* ------------------------------------------------------------------ renderer */

function renderTextToken(token, textMode) {
  if (textMode) return token.text;
  return token.tokens ? renderInline(token.tokens, false) : token.escaped ? token.text : escapeHtml(token.text);
}

function renderInline(tokens, textMode) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += textMode ? token.text : escapeHtml(token.text);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link': {
        if (textMode) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        const inner = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens, false);
        const href = cleanUrl(token.href);
        if (href === null) {
          out += inner;
          break;
        }
        let tag = '<a href="' + escapeHtml(href, token.autolink) + '"';
        if (token.title) tag += ' title="' + escapeHtml(token.title) + '"';
        out += tag + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = token.tokens ? renderInline(token.tokens, true) : token.text;
        if (textMode) {
          out += alt;
          break;
        }
        const href = cleanUrl(token.href);
        if (href === null) {
          out += escapeHtml(alt);
          break;
        }
        let tag = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
        if (token.title) tag += ' title="' + escapeHtml(token.title) + '"';
        out += tag + '>';
        break;
      }
      case 'checkbox':
        out += textMode ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += textMode ? renderInline(token.tokens, true) : '<strong>' + renderInline(token.tokens, false) + '</strong>';
        break;
      case 'em':
        out += textMode ? renderInline(token.tokens, true) : '<em>' + renderInline(token.tokens, false) + '</em>';
        break;
      case 'codespan':
        out += textMode ? token.text : '<code>' + escapeHtml(token.text, true) + '</code>';
        break;
      case 'br':
        out += textMode ? '' : '<br>';
        break;
      case 'del':
        out += textMode ? renderInline(token.tokens, true) : '<del>' + renderInline(token.tokens, false) + '</del>';
        break;
      case 'text':
        out += renderTextToken(token, textMode);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderCode(token) {
  const firstWord = (token.lang || '').match(/^\S*/)?.[0];
  const text = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  if (firstWord) {
    return '<pre><code class="language-' + escapeHtml(firstWord) + '">' + escapeHtml(text, true) + '</code></pre>\n';
  }
  return '<pre><code>' + escapeHtml(text, true) + '</code></pre>\n';
}

function renderTable(token) {
  let headerHtml = '';
  for (const cell of token.header) headerHtml += renderTableCell(cell);
  let out = '<table>\n<thead>\n' + '<tr>\n' + headerHtml + '</tr>\n' + '</thead>\n';
  let body = '';
  for (const row of token.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderTableCell(cell);
    body += '<tr>\n' + rowHtml + '</tr>\n';
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  return out + '</table>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens, false) + `</${tag}>\n`;
}

function renderList(token) {
  let items = '';
  for (const item of token.items) items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
  const tag = token.ordered ? 'ol' : 'ul';
  const start = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderBlocks(tokens) {
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
        out += '<h' + token.depth + '>' + renderInline(token.tokens, false) + '</h' + token.depth + '>\n';
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(token.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(token);
        break;
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInline(token.tokens, false) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(token, false);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ entry point */

const carriageReturn = /\r\n|\r/g;

export function parse(markdown) {
  links = Object.create(null);
  inlineQueue = [];
  state.inLink = false;
  state.inRawBlock = false;
  state.linkEmitted = false;
  state.linkParenPossible = true;
  state.top = true;
  const src = markdown.replace(carriageReturn, '\n');
  const tokens = [];
  blockTokens(src, tokens);
  for (let i = 0; i < inlineQueue.length; i++) {
    const entry = inlineQueue[i];
    state.inRawBlock = false;
    inlineTokens(entry.src, entry.tokens);
  }
  inlineQueue = [];
  return renderBlocks(tokens);
}
