const source = "аесорхуіјкмтΑΒΕΖΗΙΚΜΝΟΡΤΥΧαβεικορτυχ";
const target = "aecopxyijkmtABEZHIKMNOPTYXabeikoptyx";
const confusables = Object.fromEntries(
  [...source].map((c, i) => [c.toLowerCase(), target[i].toLowerCase()]),
);
const leet: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};
/** Preserve Unicode letters and marks alongside original numeric and leet forms. */
function normalize(value: string) {
  const text = [...value.normalize("NFKC").toLowerCase()]
    .map((c) => {
      const code = c.codePointAt(0)!;
      for (const start of [0x660, 0x6f0, 0x966, 0x9e6])
        if (code >= start && code < start + 10) return String(code - start);
      return confusables[c] ?? c;
    })
    .join("")
    .replace(/\p{Cf}|<[^>]*>/gu, "");
  const tokens = text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return {
    tokens,
    squashed: tokens.join(""),
    leet: [...text]
      .map((c) => leet[c] ?? c)
      .join("")
      .replace(/[^\p{L}\p{M}\p{N}]/gu, ""),
    digits: text.replace(/[^0-9]/g, ""),
  };
}
function atMostOneEdit(a: readonly string[], b: readonly string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const equalSuffix = (left: number, right: number): boolean => {
    while (left < a.length && right < b.length) {
      if (a[left++] !== b[right++]) return false;
    }
    return left === a.length && right === b.length;
  };
  if (i === Math.min(a.length, b.length)) return true;
  if (a.length > b.length) return equalSuffix(i + 1, i);
  if (b.length > a.length) return equalSuffix(i, i + 1);
  return (
    equalSuffix(i + 1, i + 1) ||
    (i + 1 < a.length &&
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      equalSuffix(i + 2, i + 2))
  );
}
/** Bounded one-edit comparison uses code points and linear work per candidate. */
export function matches(term: string, message: string): boolean {
  const a = normalize(term),
    b = normalize(message);
  if (a.digits.length >= 5 && a.digits.length === a.squashed.length)
    return b.digits.includes(a.digits) || b.leet.includes(a.leet);
  for (const key of ["squashed", "leet"] as const) {
    if (!a[key]) continue;
    if (b[key].includes(a[key])) return true;
    const needle = [...a[key]],
      haystack = [...b[key]];
    if (needle.length < 6) continue;
    for (const size of [needle.length - 1, needle.length, needle.length + 1])
      for (let i = 0; i + size <= haystack.length; i++)
        if (atMostOneEdit(needle, haystack.slice(i, i + size))) return true;
  }
  return false;
}
