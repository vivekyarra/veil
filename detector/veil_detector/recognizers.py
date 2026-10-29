"""High-signal local recognizers over OCR lines and adjacent line groups."""

import ipaddress
import re
import phonenumbers
from .models import Kind
from .normalize import matches

EMAIL = re.compile(r"[\w.+-]+\s*@\s*[\w-]+(?:\s*\.\s*[\w-]+)+", re.ASCII)
ADDRESS = re.compile(
    r"\b\d{1,6}\s+(?:[\w'-]+\s+){1,5}(?:street|st|avenue|ave|road|rd|lane|ln|boulevard|blvd|drive|dr|court|ct|way|rue|strasse|straße)\b",
    re.I,
)
SECRET = re.compile(
    r"(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|api[_-]?key|secret[_-]?key)\s*[:=]\s*['\"]?[^\s'\"]{6,})",
    re.I,
)


def luhn(value: str) -> bool:
    """Validate a card checksum, rejecting trivial repeated-digit strings."""
    digits = [int(c) for c in value if c.isdigit() and c.isascii()]
    if not 13 <= len(digits) <= 19 or len(set(digits)) == 1:
        return False
    return (
        sum(
            (d * 2 - 9 if d >= 5 else d * 2) if i % 2 else d for i, d in enumerate(reversed(digits))
        )
        % 10
        == 0
    )


def recognize(text: str, vault: list[str]) -> list[tuple[Kind, float]]:
    """Return categories without returning or storing the matched string."""
    found: list[tuple[Kind, float]] = []
    if EMAIL.search(text):
        found.append(("email", 0.99))
    address_text = re.sub(r"(?<=\d)(?=[A-Za-z])|(?<=[a-z])(?=[A-Z])", " ", text)
    if ADDRESS.search(address_text):
        found.append(("address", 0.93))
    if SECRET.search(text):
        found.append(("secret", 0.99))
    if any(luhn(m.group()) for m in re.finditer(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", text)):
        found.append(("card", 0.99))
    for token in re.findall(r"[0-9a-fA-F:.]{4,}", text):
        try:
            ip = ipaddress.ip_address(token.rstrip("."))
            if not ip.is_loopback and not ip.is_unspecified:
                found.append(("ip", 0.98))
                break
        except ValueError:
            continue
    for region in ["US", "GB", "IN", "CA", "AU", "DE", "FR"]:
        if any(
            phonenumbers.is_valid_number(m.number)
            for m in phonenumbers.PhoneNumberMatcher(text, region)
        ):
            found.append(("phone", 0.98))
            break
    if any(matches(term, text) for term in vault):
        found.append(("vault", 1.0))
    return found
