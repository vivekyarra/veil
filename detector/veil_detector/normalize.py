"""Shared conservative normalization and bounded fuzzy matching.

Keep in lockstep with app/electron/guard/normalize.ts; both implementations
are tested against shared/normalization-cases.json.
"""

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from rapidfuzz.distance import DamerauLevenshtein

# Lookalike letters, applied after NFKD, mark stripping and lowercasing.
CONFUSABLE_SOURCE = (
    "авеёѕіїјкмнопрстухьԁԛԝһӏɡαβγεζηικμνορτυχωςօսհոցզıȷłøđħŧƀɑɩɪʟɴʀʏᴀʙᴄᴅᴇɢʜᴊᴋᴍᴏᴘꜱᴛᴜᴠᴡᴢ"
)
CONFUSABLE_TARGET = (
    "abeesiijkmhonpctyxbdqwhlgabyezhikmnoptyxwsouhngqijlodhtbaiilnryabcdeghjkmopstuvwz"
)
if len(CONFUSABLE_SOURCE) != len(CONFUSABLE_TARGET):
    raise RuntimeError("Confusable table mismatch")
DIGIT_BLOCKS = (
    0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6,
    0xD66, 0xE50, 0xED0, 0xF20, 0x1040, 0x17E0, 0x1810,
)  # fmt: skip
CANONICAL = str.maketrans(dict(zip(CONFUSABLE_SOURCE, CONFUSABLE_TARGET)))
CANONICAL.update({start + i: str(i) for start in DIGIT_BLOCKS for i in range(10)})
_LEET_COMMON = {
    "0": "o",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "8": "b",
    "9": "g",
    "@": "a",
    "$": "s",
}
LEET_A = str.maketrans({**_LEET_COMMON, "1": "i", "|": "l"})
LEET_B = str.maketrans({**_LEET_COMMON, "1": "l", "|": "i"})
SHORT_TERM = 5
FUZZY_MIN = 6
FUZZY_MAX = 128
# Angle brackets are separators; stripping "<...>" spans hid leaks. Matches normalize.ts.
_TAG = re.compile(r"[<>]")
_CHUNK = re.compile(r"[0-9oil|]+")
_GAP = re.compile(r"[ \-.()]*")
_UNSPACED = re.compile("[฀-໿က-႟ក-៿⺀-鿿豈-﫿\U00020000-\U0003ffff]")


def _canonical(value: str) -> str:
    text = unicodedata.normalize("NFKD", unicodedata.normalize("NFKD", value).lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn").translate(CANONICAL)
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")
    return _TAG.sub(" ", text)


def _words(text: str) -> list[str]:
    return "".join(c if unicodedata.category(c)[0] in "LMN" else " " for c in text).split()


def _number_runs(text: str) -> list[str]:
    """Join digits only inside one contiguous number-like run."""
    runs: list[str] = []
    current, end = "", -1
    for chunk in _CHUNK.finditer(text):
        raw = chunk.group()
        if not re.search("[0-9]", raw):
            continue
        digits = re.sub("[il|]", "1", raw.replace("o", "0"))
        if end >= 0 and _GAP.fullmatch(text, end, chunk.start()):
            current += digits
        else:
            if current:
                runs.append(current)
            current = digits
        end = chunk.end()
    if current:
        runs.append(current)
    return runs


@dataclass(frozen=True)
class NormalizedMessage:
    tokens: list[str]
    leet_a: list[str]
    leet_b: list[str]
    runs: list[str]


@dataclass(frozen=True)
class CompiledTerm:
    squashed: str
    leet: str
    digits: str
    phone: bool
    short: bool


def normalize_message(message: str) -> NormalizedMessage:
    text = _canonical(message)
    return NormalizedMessage(
        _words(text),
        _words(text.translate(LEET_A)),
        _words(text.translate(LEET_B)),
        _number_runs(text),
    )


@lru_cache(maxsize=4096)
def compile_term(term: str) -> CompiledTerm:
    """Terms are compiled once; the cache bounds repeated vault scans."""
    text = _canonical(term)
    squashed = "".join(_words(text))
    digits = "".join(re.findall("[0-9]", text))
    return CompiledTerm(
        squashed,
        "".join(_words(text.translate(LEET_A))),
        digits,
        len(digits) >= 5 and digits == squashed,
        len(squashed) <= SHORT_TERM and not _UNSPACED.search(squashed),
    )


def _in_tokens(needle: str, tokens: list[str], short: bool) -> bool:
    if short:
        for i in range(len(tokens)):
            joined = ""
            for token in tokens[i:]:
                if len(joined) >= len(needle):
                    break
                joined += token
            if joined == needle:
                return True
        return False
    hay = "".join(tokens)
    if needle in hay:
        return True
    if not FUZZY_MIN <= len(needle) <= FUZZY_MAX:
        return False
    for length in (len(needle) - 1, len(needle), len(needle) + 1):
        for start in range(len(hay) - length + 1):
            if (
                DamerauLevenshtein.distance(needle, hay[start : start + length], score_cutoff=1)
                <= 1
            ):
                return True
    return False


def match_compiled(term: CompiledTerm, message: NormalizedMessage) -> bool:
    if not term.squashed:
        return False
    if term.phone:
        return any(term.digits in run for run in message.runs)
    return (
        _in_tokens(term.squashed, message.tokens, term.short)
        or _in_tokens(term.leet, message.leet_a, term.short)
        or _in_tokens(term.leet, message.leet_b, term.short)
    )


def matches(term: str, message: str) -> bool:
    """Match whole words for short terms and bounded substrings otherwise."""
    return match_compiled(compile_term(term), normalize_message(message))
