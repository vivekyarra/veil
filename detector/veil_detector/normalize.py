"""Shared conservative normalization and bounded fuzzy matching."""

import re
import unicodedata
from rapidfuzz.distance import DamerauLevenshtein

CONFUSABLES = str.maketrans(
    {
        a.lower(): b.lower()
        for a, b in zip(
            "аесорхуіјкмтΑΒΕΖΗΙΚΜΝΟΡΤΥΧαβεικορτυχ", "aecopxyijkmtABEZHIKMNOPTYXabeikoptyx"
        )
    }
)
LEET = str.maketrans("013457@$", "oieast as".replace(" ", ""))
DECIMAL_MAP: dict[int, str] = {
    start + i: str(i) for start in (0x660, 0x6F0, 0x966, 0x9E6) for i in range(10)
}
CONFUSABLES.update(DECIMAL_MAP)


def normalize(value: str) -> dict[str, str | list[str]]:
    """Keep numeric originals alongside a separate leetspeak variant."""
    text = unicodedata.normalize("NFKC", value).lower().translate(CONFUSABLES)
    text = re.sub(r"<[^>]*>", "", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")

    def words(value: str) -> list[str]:
        return "".join(
            c if c.isalnum() or unicodedata.category(c).startswith("M") else " " for c in value
        ).split()

    tokens = words(text)
    squashed = "".join(tokens)
    return {
        "tokens": tokens,
        "squashed": squashed,
        "leet": "".join(words(text.translate(LEET))),
        "digits": "".join(re.findall(r"[0-9]", text)),
    }


def matches(term: str, message: str) -> bool:
    """Match bounded substrings, including one transposition for long terms."""
    a, b = normalize(term), normalize(message)
    digits = str(a["digits"])
    if len(digits) >= 5 and len(digits) == len(str(a["squashed"])):
        return digits in str(b["digits"]) or str(a["leet"]) in str(b["leet"])
    for key in ("squashed", "leet"):
        needle, haystack = str(a[key]), str(b[key])
        if not needle:
            continue
        if needle in haystack:
            return True
        if len(needle) < 6:
            continue
        for length in (len(needle) - 1, len(needle), len(needle) + 1):
            for start in range(len(haystack) - length + 1):
                if (
                    DamerauLevenshtein.distance(
                        needle, haystack[start : start + length], score_cutoff=1
                    )
                    <= 1
                ):
                    return True
    return False
