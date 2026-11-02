"""High-signal local recognizers over OCR lines and adjacent line groups.

Scope decisions (documented in docs/benchmark.md):
- Private, loopback, link-local, CGNAT and multicast IP addresses are not flagged. They do
  not identify a viewer or streamer on the public internet and appear constantly in router
  pages, dev consoles and game server browsers. Public IPv4/IPv6 addresses are flagged.
- Dotted numbers in a version context ("v1.2.3.4", "version 4.18.2.0", "build ...") are
  never treated as IP addresses.
"""

import ipaddress
import re
import phonenumbers
from .models import Kind
from .normalize import matches

# OCR may split "user @ domain.com" symmetrically; one-sided spaces ("thanks @streamer.gg")
# are chat mentions. Dots inside the domain must not be spaced and the TLD is 2+ letters.
EMAIL = re.compile(
    r"(?<![\w.+-])[A-Za-z0-9][\w.+-]*(?:@| @ )[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])",
    re.ASCII,
)
_STREET_EN = (
    r"street|st|avenue|ave|road|rd|lane|ln|boulevard|blvd|drive|dr|court|ct|way|terrace|"
    r"crescent|parkway|pkwy|highway|hwy|rue|strasse|straße"
)
ADDRESS_NUMBER_FIRST = re.compile(
    r"\b\d{1,6}[a-z]?\s+(?:[\w'-]+\s+){1,5}(?:" + _STREET_EN + r")\b\.?", re.I
)
# French: "12 rue de la Paix", "5 bis avenue Victor Hugo", "8, boulevard Haussmann".
ADDRESS_FR = re.compile(
    r"\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|place|chemin|allée|allee|"
    r"impasse|quai|cours)\s+[\w'-]+",
    re.I,
)
# German / Austrian / Swiss: street name with suffix, number after ("Hauptstraße 5",
# "Lindenweg 12a", "Berliner Str. 7", "Am Markt 3" is out of scope without a suffix).
ADDRESS_DE = re.compile(
    r"\b[A-ZÄÖÜ][\wäöüß-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee)"
    r"\s+\d{1,4}\s?[a-z]?\b",
)
ADDRESS_DE_TWO_WORD = re.compile(
    r"\b[A-ZÄÖÜ][\wäöüß-]+\s+(?:Straße|Strasse|Str\.|Weg|Gasse|Platz|Allee|Ring|Damm)"
    r"\s+\d{1,4}\s?[a-z]?\b",
)
UK_POSTCODE_LINE = re.compile(
    r"\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3},?\s+[A-Z][a-z]+,?\s+"
    r"[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"
)
SECRET = re.compile(
    r"(?:"
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"
    r"|\bgh[pousr]_[A-Za-z0-9]{30,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{40,}"
    r"|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}"
    r"|\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|\bAIza[0-9A-Za-z_-]{35}"
    r"|\bglpat-[A-Za-z0-9_-]{20,}"
    r"|\bxox[abposr]-[A-Za-z0-9-]{10,}"
    r"|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*"
    r"|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
    r"|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"|\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*['\"]?[A-Za-z0-9/+]{40}"
    r"|(?:\b|(?<=_))(?:password|passwd|pwd|passcode|api[_-]?key|secret[_-]?key|client[_-]?secret|"
    r"access[_-]?token|auth[_-]?token)\s*[:=]\s*['\"]?[^\s'\"]{6,}"
    # Without a separator the value must look like a credential (contains a digit or symbol).
    r"|\b(?:password|passwd|passcode)\s+(?=[^\s]*[\d!#$%^&*?])[^\s]{6,}"
    r")",
    re.I,
)
SSN = re.compile(r"(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])")
UK_NINO = re.compile(
    r"\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b"
)
# OCR often glues the label to the value ("IBANDE89...").
IBAN = re.compile(
    r"(?:\b|(?<=IBAN)|(?<=IBAN:))[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b"
)
CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)")
IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])")
VERSION_CONTEXT = re.compile(
    r"(?:\bv|\bver|\bversion|\bbuild|\brelease|\brev|\bfirmware|\bpatch)\.?\s*$", re.I
)
NON_PUBLIC_V4 = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
]
# Numbers that a phone matcher would otherwise accept but that carry explicit non-phone labels.
NON_PHONE_CONTEXT = re.compile(
    r"(?:\b(?:steuer\w*|st\.?-?nr|tax|ust|vat|order|invoice|rechnung\w*|bestell\w*|ticket|ref|"
    r"id|tracking|sku|serial|iban|ssn|build|version)|#)\W{0,3}$",
    re.I,
)
# Dates and clock times are blanked before phone matching, unless they are part of a longer
# separated digit run such as the French "01.23.45.67.89" phone format.
DATE = re.compile(
    r"(?<!\d[-/.:])\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}"
    r"|\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\b(?![-/.:]\d)"
)
# Dotted digit runs: IPv4 shapes (public or private), versions and builds are never phones.
DOTTED = re.compile(r"(?<![\d.])\d+(?:\.\d+){2,}(?![\d.])")
PHONE_REGIONS = ["US", "GB", "IN", "CA", "AU", "DE", "FR"]
# A valid-looking national number alone is not enough evidence: scores, ids, prices and
# timestamps routinely parse as valid numbers somewhere. Without a "+" prefix a phone needs a
# label or context word within PHONE_CONTEXT_WINDOW characters before it.
PHONE_CONTEXT_WINDOW = 32
PHONE_CONTEXT = re.compile(
    r"(?:\b(?:phone|ph|tel|tél|telephone|téléphone|telefon|telefonnummer|mobile?|mobil|"
    r"portable|handy|cell|cellphone|call|text|sms|whatsapp|signal|fax|contact|landline|"
    r"phone\s?no)\b\.?|☎|📞)",
    re.I,
)
# Layouts only phone numbers use count as context on their own: the French five-pair
# "01.23.45.67.89" / "01 23 45 67 89" and the NANP "(415) 555-0132".
PHONE_LAYOUT = re.compile(r"0\d(?:([ .])\d{2})(?:\1\d{2}){3}|\(\d{3}\)\s?\d{3}[-. ]\d{4}")
# Order, tracking, invoice and tax contexts anywhere in the window veto a phone reading.
PHONE_VETO = re.compile(
    r"\b(?:order\w*|tracking|track|invoice\w*|inv|tax\w*|steuer\w*|st\.?-?nr|ust\w*|vat|"
    r"rechnung\w*|bestell\w*|sendung\w*|receipt|shipment|parcel|awb|ticket|sku|serial|"
    r"ref(?:erence)?|confirmation|booking|account|acct|customer)\b",
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


def iban_valid(value: str) -> bool:
    """ISO 13616 mod-97 check over a whitespace-free candidate."""
    compact = value.replace(" ", "").upper()
    if not 15 <= len(compact) <= 34 or not compact[:2].isalpha() or not compact[2:4].isdigit():
        return False
    rearranged = compact[4:] + compact[:4]
    try:
        number = int("".join(str(int(c, 36)) for c in rearranged))
    except ValueError:
        return False
    return number % 97 == 1


def _public_ip(token: str) -> bool:
    try:
        ip = ipaddress.ip_address(token)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv4Address):
        return not any(ip in network for network in NON_PUBLIC_V4) and ip != ipaddress.IPv4Address(
            "255.255.255.255"
        )
    return not (
        ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_private or ip.is_multicast
    )


def _has_ip(text: str) -> list[tuple[int, int]]:
    spans = []
    for match in IPV4.finditer(text):
        if VERSION_CONTEXT.search(text[: match.start()]):
            continue
        if _public_ip(match.group()):
            spans.append(match.span())
    for match in IPV6.finditer(text):
        if match.group().count(":") >= 2 and _public_ip(match.group()):
            spans.append(match.span())
    return spans


def _blank(text: str, spans: list[tuple[int, int]]) -> str:
    for start, end in spans:
        text = text[:start] + " " * (end - start) + text[end:]
    return text


def _not_phone_dotted(text: str, match: re.Match[str]) -> bool:
    groups = match.group().split(".")
    return (
        IPV4.fullmatch(match.group()) is not None
        or any(len(group) == 1 for group in groups)
        or VERSION_CONTEXT.search(text[: match.start()]) is not None
        or text[: match.start()].endswith("/")
    )


def _phone(text: str) -> bool:
    for region in PHONE_REGIONS:
        for match in phonenumbers.PhoneNumberMatcher(text, region):
            raw = match.raw_string
            before = text[max(0, match.start - PHONE_CONTEXT_WINDOW) : match.start]
            if raw.count("/") > 1 or NON_PHONE_CONTEXT.search(text[: match.start]):
                continue
            if PHONE_VETO.search(before) or not phonenumbers.is_valid_number(match.number):
                continue
            if (
                raw.lstrip("( ").startswith("+")
                or PHONE_LAYOUT.fullmatch(raw.strip())
                or PHONE_CONTEXT.search(before)
            ):
                return True
    return False


def recognize(text: str, vault: list[str]) -> list[tuple[Kind, float]]:
    """Return categories without returning or storing the matched string."""
    found: list[tuple[Kind, float]] = []
    consumed: list[tuple[int, int]] = []
    if EMAIL.search(text):
        found.append(("email", 0.99))
    address_text = re.sub(r"(?<=\d)(?=[A-Za-z]{2})|(?<=[a-z])(?=[A-Z])", " ", text)
    if (
        ADDRESS_NUMBER_FIRST.search(address_text)
        or ADDRESS_FR.search(text)
        or ADDRESS_DE.search(text)
        or ADDRESS_DE_TWO_WORD.search(text)
        or UK_POSTCODE_LINE.search(text)
    ):
        found.append(("address", 0.93))
    if SECRET.search(text):
        found.append(("secret", 0.99))
    ibans = [m for m in IBAN.finditer(text) if iban_valid(m.group())]
    if ibans:
        found.append(("iban", 0.99))
        consumed += [m.span() for m in ibans]
    cards = [m for m in CARD.finditer(_blank(text, consumed)) if luhn(m.group())]
    if cards:
        found.append(("card", 0.99))
        consumed += [m.span() for m in cards]
    national = list(SSN.finditer(text)) + list(UK_NINO.finditer(text))
    if national:
        found.append(("national_id", 0.97))
        consumed += [m.span() for m in national]
    ips = _has_ip(text)
    if ips:
        found.append(("ip", 0.98))
    consumed += ips
    consumed += [m.span() for m in DATE.finditer(text)]
    consumed += [m.span() for m in DOTTED.finditer(text) if _not_phone_dotted(text, m)]
    if _phone(_blank(text, consumed)):
        found.append(("phone", 0.98))
    if any(matches(term, text) for term in vault):
        found.append(("vault", 1.0))
    return found
