/*
 * Cross-language chat matcher. Keep this file in lockstep with
 * detector/veil_detector/normalize.py; shared/normalization-cases.json is
 * the contract both implementations are tested against.
 */

// Lookalike letters, applied after NFKD, mark stripping and lowercasing.
// Pairs are index-aligned code points. Keep identical to normalize.py.
const CONFUSABLE_SOURCE =
  "авеёѕіїјкмнопрстухьԁԛԝһӏɡαβγεζηικμνορτυχωςօսհոցզıȷłøđħŧƀɑɩɪʟɴʀʏᴀʙᴄᴅᴇɢʜᴊᴋᴍᴏᴘꜱᴛᴜᴠᴡᴢ";
const CONFUSABLE_TARGET =
  "abeesiijkmhonpctyxbdqwhlgabyezhikmnoptyxwsouhngqijlodhtbaiilnryabcdeghjkmopstuvwz";
const confusables = new Map<string, string>();
{
  const from = [...CONFUSABLE_SOURCE],
    to = [...CONFUSABLE_TARGET];
  if (from.length !== to.length) throw new Error("Confusable table mismatch");
  from.forEach((c, i) => confusables.set(c, to[i]));
}
// Native decimal digits not folded by NFKD.
const DIGIT_BLOCKS = [
  0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6,
  0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810,
];
// Two leet readings: "1" and "|" are read as either i or l.
const LEET_COMMON: Record<string, string> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
};
const LEET_A: Record<string, string> = { ...LEET_COMMON, "1": "i", "|": "l" };
const LEET_B: Record<string, string> = { ...LEET_COMMON, "1": "l", "|": "i" };
const SHORT_TERM = 5;
const FUZZY_MIN = 6;
const FUZZY_MAX = 128;

function canonical(value: string): string {
  // ASCII is unchanged by NFKD, has no marks, confusables, native digits or
  // format characters, so only case and brackets apply.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value))
    return value.toLowerCase().replace(/[<>]/g, " ");
  const folded = value
    .normalize("NFKD")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "");
  let out = "";
  for (const c of folded) {
    const code = c.codePointAt(0)!;
    const block = DIGIT_BLOCKS.find((s) => code >= s && code < s + 10);
    out +=
      block === undefined ? (confusables.get(c) ?? c) : String(code - block);
  }
  // Angle brackets become separators. Stripping whole "<...>" spans let a
  // leak hide inside brackets, which Twitch chat displays verbatim.
  return out.replace(/\p{Cf}/gu, "").replace(/[<>]/g, " ");
}
const words = (text: string): string[] =>
  text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const leet = (text: string, table: Record<string, string>): string =>
  [...text].map((c) => table[c] ?? c).join("");

/** Digit strings joined only inside one contiguous number-like run. */
function numberRuns(text: string): string[] {
  const runs: string[] = [];
  let current = "",
    end = -1;
  for (const chunk of text.matchAll(/[0-9oil|]+/g)) {
    const raw = chunk[0],
      start = chunk.index;
    if (!/[0-9]/.test(raw)) continue;
    const digits = raw.replace(/o/g, "0").replace(/[il|]/g, "1");
    if (end >= 0 && /^[ \-.()]*$/.test(text.slice(end, start)))
      current += digits;
    else {
      if (current) runs.push(current);
      current = digits;
    }
    end = start + raw.length;
  }
  if (current) runs.push(current);
  return runs;
}

/** Scripts written without spaces cannot use word boundaries. */
const unspaced = (text: string): boolean =>
  /[฀-໿က-႟ក-៿⺀-鿿豈-﫿\u{20000}-\u{3ffff}]/u.test(text);

interface Haystack {
  tokens: string[];
  joined: string;
  chars: string[];
}
interface NormalizedMessage {
  tokens: Haystack;
  leetA: Haystack;
  leetB: Haystack;
  runs: string[];
  /** Every two-code-unit substring of the three haystacks. */
  bigrams: Set<string>;
}
export interface CompiledTerm {
  squashed: string;
  leet: string;
  squashedChars: string[];
  leetChars: string[];
  digits: string;
  phone: boolean;
  short: boolean;
  /** Leading bigram of each fuzzy piece; one must occur for any match. */
  anchors: string[];
}

/** The three pieces used by fuzzyIn; see its comment. */
function pieces(a: readonly string[]): string[] {
  const n = a.length,
    cuts = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n];
  return [0, 1, 2].map((p) => a.slice(cuts[p], cuts[p + 1]).join(""));
}

function haystack(tokens: string[]): Haystack {
  const joined = tokens.join("");
  return { tokens, joined, chars: [...joined] };
}

export function normalizeMessage(message: string): NormalizedMessage {
  const text = canonical(message),
    tokens = haystack(words(text)),
    leetA = haystack(words(leet(text, LEET_A))),
    leetB = haystack(words(leet(text, LEET_B))),
    bigrams = new Set<string>();
  for (const { joined } of [tokens, leetA, leetB])
    for (let i = 0; i + 2 <= joined.length; i++)
      bigrams.add(joined.slice(i, i + 2));
  return { tokens, leetA, leetB, runs: numberRuns(text), bigrams };
}

export function compileTerm(term: string): CompiledTerm {
  const text = canonical(term),
    squashed = words(text).join(""),
    digits = text.replace(/[^0-9]/g, ""),
    leetText = words(leet(text, LEET_A)).join(""),
    squashedChars = [...squashed],
    leetChars = [...leetText],
    // Prefilter only applies when both needles split into 2+ char pieces.
    anchors =
      squashedChars.length >= FUZZY_MIN && leetChars.length >= FUZZY_MIN
        ? [...pieces(squashedChars), ...pieces(leetChars)].map((p) =>
            p.slice(0, 2),
          )
        : [];
  return {
    squashed,
    leet: leetText,
    squashedChars,
    leetChars,
    digits,
    phone: digits.length >= 5 && digits === squashed,
    short: squashedChars.length <= SHORT_TERM && !unspaced(squashed),
    anchors,
  };
}

function atMostOneEdit(
  a: readonly string[],
  b: readonly string[],
  offset: number,
  size: number,
): boolean {
  if (Math.abs(a.length - size) > 1) return false;
  let i = 0;
  while (i < a.length && i < size && a[i] === b[offset + i]) i++;
  const equalSuffix = (left: number, right: number): boolean => {
    while (left < a.length && right < size)
      if (a[left++] !== b[offset + right++]) return false;
    return left === a.length && right === size;
  };
  if (i === Math.min(a.length, size)) return true;
  if (a.length > size) return equalSuffix(i + 1, i);
  if (size > a.length) return equalSuffix(i, i + 1);
  return (
    equalSuffix(i + 1, i + 1) ||
    (i + 1 < a.length &&
      a[i] === b[offset + i + 1] &&
      a[i + 1] === b[offset + i] &&
      equalSuffix(i + 2, i + 2))
  );
}
/**
 * One edit (substitution, insertion, deletion or adjacent transposition)
 * touches at most two of three consecutive pieces of the needle, so one
 * piece always occurs verbatim. Only windows anchored on a verbatim piece
 * are checked; this is equivalent to scanning every window.
 */
function fuzzyIn(a: readonly string[], hay: Haystack): boolean {
  const b = hay.chars,
    bmp = hay.joined.length === b.length,
    n = a.length,
    cuts = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n];
  for (let p = 0; p < 3; p++) {
    const offset = cuts[p],
      size = cuts[p + 1] - offset,
      piece = a.slice(offset, offset + size).join("");
    if (!hay.joined.includes(piece)) continue;
    for (let i = 0; i + size <= b.length; i++) {
      if (bmp) {
        i = hay.joined.indexOf(piece, i);
        if (i < 0) break;
      } else {
        let k = 0;
        while (k < size && b[i + k] === a[offset + k]) k++;
        if (k < size) continue;
      }
      const base = i - offset;
      for (const window of [n - 1, n, n + 1])
        for (let start = base - 1; start <= base + 1; start++)
          if (
            start >= 0 &&
            start + window <= b.length &&
            atMostOneEdit(a, b, start, window)
          )
            return true;
    }
  }
  return false;
}
function inTokens(
  needle: string,
  chars: readonly string[],
  hay: Haystack,
  short: boolean,
): boolean {
  if (short) {
    // Whole-word: the term equals a contiguous run of complete tokens.
    const tokens = hay.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (!needle.startsWith(tokens[i])) continue;
      let joined = "";
      for (let j = i; j < tokens.length && joined.length < needle.length; j++)
        joined += tokens[j];
      if (joined === needle) return true;
    }
    return false;
  }
  if (hay.joined.includes(needle)) return true;
  if (chars.length < FUZZY_MIN || chars.length > FUZZY_MAX) return false;
  return fuzzyIn(chars, hay);
}

/** Bounded matching; terms are compiled once and messages normalized once. */
export function matchCompiled(
  term: CompiledTerm,
  message: NormalizedMessage,
): boolean {
  if (!term.squashed) return false;
  if (term.phone) return message.runs.some((run) => run.includes(term.digits));
  // Exact and one-edit matches both contain a verbatim piece of the needle.
  if (
    !term.short &&
    term.anchors.length &&
    !term.anchors.some((anchor) => message.bigrams.has(anchor))
  )
    return false;
  return (
    inTokens(term.squashed, term.squashedChars, message.tokens, term.short) ||
    inTokens(term.leet, term.leetChars, message.leetA, term.short) ||
    inTokens(term.leet, term.leetChars, message.leetB, term.short)
  );
}

export function matches(term: string, message: string): boolean {
  return matchCompiled(compileTerm(term), normalizeMessage(message));
}
