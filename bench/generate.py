"""Render synthetic 1080p screens with pixel-derived truth, never actual desktop data.

Every value is drawn from a seeded RNG: random Luhn-valid cards across brands, valid phone
numbers from many countries, secrets from many providers, varied e-mail domains, US / UK /
German / French addresses, per-screen vault terms, public IPs, SSN / NINO and mod-97 IBANs.
Screens mix several rows, put hard-negative distractors next to targets (sometimes on the
same row) and a share of screens contain only hard negatives.

Ground truth is the glyph ink box: each screen is captured twice, once with every labelled
span's text made transparent, and the pixel difference inside the DOM box gives the box.
"""

from __future__ import annotations

import argparse
import base64
import html
import io
import json
import random
import string
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import phonenumbers
from faker import Faker
from PIL import Image
from playwright.sync_api import sync_playwright

FONTS = [
    "Arial",
    "Verdana",
    "Georgia",
    "Times New Roman",
    "Courier New",
    "Trebuchet MS",
    "Tahoma",
    "Consolas",
    "Segoe UI",
]
SURFACES = [
    "Inbox",
    "Direct messages",
    "Browser",
    "Terminal",
    "Checkout",
    "Account settings",
    "Arena scoreboard",
    "Code editor",
    "Stream chat",
    "Shipping form",
]
TARGET_KINDS = [
    "email",
    "card",
    "secret",
    "vault",
    "phone",
    "address",
    "ip",
    "national_id",
    "iban",
]
NEGATIVE_CATEGORIES = [
    "code",
    "chat_mention",
    "time_at",
    "version",
    "private_ip",
    "date",
    "reference_number",
    "non_luhn_16",
    "scoreboard",
    "url",
]
PHONE_REGIONS = [
    "US",
    "GB",
    "DE",
    "FR",
    "IN",
    "CA",
    "AU",
    "ES",
    "IT",
    "NL",
    "BR",
    "JP",
    "MX",
]
ALNUM = string.ascii_letters + string.digits
URLSAFE = ALNUM + "-_"


class Values:
    """Seeded generators for sensitive values and hard negatives."""

    def __init__(self, rng: random.Random, seed: int) -> None:
        self.rng = rng
        self.fakes = {loc: Faker(loc) for loc in ("en_US", "en_GB", "de_DE", "fr_FR")}
        for offset, fake in enumerate(self.fakes.values()):
            fake.seed_instance(seed + offset)
        self.fake = self.fakes["en_US"]

    def chars(self, alphabet: str, n: int) -> str:
        return "".join(self.rng.choice(alphabet) for _ in range(n))

    # --- sensitive values -------------------------------------------------------------
    def card(self) -> tuple[str, str, list[str]]:
        rng = self.rng
        brand, prefix, length = rng.choice(
            [
                ("visa", "4", 16),
                ("mastercard", str(rng.randint(51, 55)), 16),
                ("mastercard", str(rng.randint(2221, 2720)), 16),
                ("amex", rng.choice(["34", "37"]), 15),
                ("discover", rng.choice(["6011", "65"]), 16),
            ]
        )
        body = prefix + "".join(
            str(rng.randint(0, 9)) for _ in range(length - len(prefix) - 1)
        )
        total = 0
        for i, d in enumerate(int(c) for c in reversed(body)):
            total += (d * 2 - 9 if d >= 5 else d * 2) if i % 2 == 0 else d
        digits = body + str((10 - total % 10) % 10)
        groups = (
            [digits[:4], digits[4:10], digits[10:]]
            if length == 15
            else [digits[i : i + 4] for i in range(0, 16, 4)]
        )
        style = rng.choice(["space", "space", "dash", "plain"])
        text = {"space": " ".join(groups), "dash": "-".join(groups), "plain": digits}[
            style
        ]
        return text, f"{brand}-{style}", groups

    def phone(self) -> tuple[str, str]:
        rng = self.rng
        region = rng.choice(PHONE_REGIONS)
        kind = rng.choice(
            [
                phonenumbers.PhoneNumberType.MOBILE,
                phonenumbers.PhoneNumberType.FIXED_LINE,
            ]
        )
        example = phonenumbers.example_number_for_type(region, kind)
        number = example
        if example is not None:
            national = str(example.national_number)
            for _ in range(40):
                candidate = national[:-4] + "".join(
                    str(rng.randint(0, 9)) for _ in range(4)
                )
                parsed = phonenumbers.parse("+" + str(example.country_code) + candidate)
                if phonenumbers.is_valid_number(parsed):
                    number = parsed
                    break
        assert number is not None
        style = rng.choice(["INTERNATIONAL", "INTERNATIONAL", "NATIONAL", "E164"])
        fmt = getattr(phonenumbers.PhoneNumberFormat, style)
        return phonenumbers.format_number(number, fmt), f"{region}-{style.lower()}"

    def secret(self) -> tuple[str, str]:
        rng = self.rng
        c = self.chars

        def jwt() -> str:
            def part(data: dict[str, Any]) -> str:
                raw = json.dumps(data, separators=(",", ":")).encode()
                return base64.urlsafe_b64encode(raw).decode().rstrip("=")

            claims = {
                "sub": c(string.digits, 10),
                "name": self.fake.first_name(),
                "iat": 1716,
            }
            return f"{part({'alg': 'HS256', 'typ': 'JWT'})}.{part(claims)}.{c(URLSAFE, 43)}"

        password = (
            c(string.ascii_lowercase, rng.randint(4, 8))
            + c(string.digits, 2)
            + c("!#$", 1)
        )
        providers: list[tuple[str, Callable[[], str]]] = [
            (
                "aws_access_key",
                lambda: "aws_access_key_id = AKIA"
                + c(string.ascii_uppercase + string.digits, 16),
            ),
            ("aws_secret", lambda: "AWS_SECRET_ACCESS_KEY=" + c(ALNUM + "/+", 40)),
            ("github_classic", lambda: "GITHUB_TOKEN=ghp_" + c(ALNUM, 36)),
            ("github_fine", lambda: "github_pat_" + c(ALNUM, 22) + "_" + c(ALNUM, 59)),
            ("github_app", lambda: rng.choice(["ghs_", "gho_", "ghu_"]) + c(ALNUM, 36)),
            (
                "openai",
                lambda: "OPENAI_API_KEY=sk-"
                + rng.choice(["", "proj-"])
                + c(URLSAFE, 48),
            ),
            (
                "stripe",
                lambda: rng.choice(["sk_live_", "sk_test_", "rk_live_"]) + c(ALNUM, 24),
            ),
            ("google", lambda: "AIza" + c(URLSAFE, 35)),
            ("gitlab", lambda: "glpat-" + c(URLSAFE, 20)),
            (
                "slack",
                lambda: rng.choice(["xoxb-", "xoxp-"])
                + c(string.digits, 11)
                + "-"
                + c(string.digits, 12)
                + "-"
                + c(ALNUM, 24),
            ),
            (
                "bearer",
                lambda: "Authorization: Bearer "
                + c(URLSAFE + ".", rng.randint(32, 48)),
            ),
            ("jwt", jwt),
            (
                "password_colon",
                lambda: rng.choice(["password: ", "Password: ", "pwd="]) + password,
            ),
            (
                "password_bare",
                lambda: rng.choice(["password ", "Password "]) + password,
            ),
            ("env_password", lambda: "DB_PASSWORD=" + password),
            (
                "api_key",
                lambda: rng.choice(["api_key=", "API_KEY: ", "secret_key = "])
                + c(string.hexdigits.lower()[:16], 32),
            ),
        ]
        name, make = rng.choice(providers)
        return make(), name

    def email(self) -> tuple[str, str]:
        rng, fake = self.rng, self.fakes[self.rng.choice(list(self.fakes))]
        first, last = fake.first_name(), fake.last_name()

        def ascii_name(value: str) -> str:
            return "".join(ch for ch in value.lower() if ch in string.ascii_lowercase)

        first, last = ascii_name(first) or "alex", ascii_name(last) or "morgan"
        local = rng.choice(
            [
                f"{first}.{last}",
                f"{first[0]}{last}",
                f"{first}_{last}{rng.randint(1, 99)}",
                f"{first}+{rng.choice(['stream', 'news', 'shop'])}",
                f"{last}{rng.randint(1970, 2010)}",
            ]
        )
        domain = rng.choice(
            [
                fake.free_email_domain(),
                fake.domain_name(),
                f"{last}.{rng.choice(['io', 'dev', 'co.uk', 'de', 'fr', 'net', 'org', 'com.au'])}",
                f"mail.{fake.domain_name()}",
            ]
        )
        text = f"{local}@{domain}"
        if rng.random() < 0.2:
            text = text.capitalize()
        return text, domain.rsplit(".", 1)[-1]

    def address(self) -> tuple[str, str]:
        rng = self.rng
        style = rng.choice(["us", "us", "uk", "de", "fr"])
        if style == "us":
            fake = self.fakes["en_US"]
            suffix = rng.choice(
                [
                    "Street",
                    "St",
                    "Avenue",
                    "Ave",
                    "Road",
                    "Rd",
                    "Lane",
                    "Drive",
                    "Blvd",
                    "Court",
                    "Way",
                ]
            )
            text = f"{rng.randint(1, 9999)} {fake.last_name()} {suffix}"
            if rng.random() < 0.5:
                text += f", {fake.city()}, {fake.state_abbr()} {fake.zipcode()}"
        elif style == "uk":
            fake = self.fakes["en_GB"]
            suffix = rng.choice(
                [
                    "Road",
                    "Street",
                    "Lane",
                    "Close",
                    "Crescent",
                    "Gardens",
                    "Grove",
                    "Terrace",
                ]
            )
            number = f"{rng.randint(1, 300)}{rng.choice(['', '', 'A', 'B'])}"
            text = f"{number} {fake.last_name()} {suffix}"
            if rng.random() < 0.6:
                text += f", {fake.city()} {fake.postcode()}"
        elif style == "de":
            fake = self.fakes["de_DE"]
            name = rng.choice(
                [fake.last_name(), "Haupt", "Linden", "Bahnhof", "Schiller", "Garten"]
            )
            street = rng.choice(
                [
                    f"{name}{rng.choice(['straße', 'str.', 'weg', 'gasse', 'platz', 'allee', 'ring'])}",
                    f"{fake.city()}er Straße",
                ]
            )
            text = f"{street} {rng.randint(1, 180)}{rng.choice(['', '', 'a', 'b'])}"
            if rng.random() < 0.6:
                text += f", {fake.postcode()} {fake.city()}"
        else:
            fake = self.fakes["fr_FR"]
            way = rng.choice(
                ["rue", "avenue", "boulevard", "place", "impasse", "chemin", "quai"]
            )
            text = f"{rng.randint(1, 200)}{rng.choice(['', '', ' bis'])} {way} {rng.choice(['de la ', 'du ', 'des ', ''])}{fake.last_name()}"
            if rng.random() < 0.6:
                text += f", {fake.postcode()} {fake.city()}"
        return text, style

    def vault_term(self) -> str:
        rng, fake = self.rng, self.fakes[self.rng.choice(list(self.fakes))]
        return rng.choice(
            [
                fake.name(),
                f"{fake.last_name()} {rng.choice(['Academy', 'High School', 'Primary School', 'Elementary'])}",
                f"{fake.city()} {rng.choice(['Clinic', 'Dental', 'Kita', 'Gym', 'Library'])}",
                fake.company(),
                f"{rng.choice(['Biscuit', 'Mochi', 'Pepper', 'Juniper', 'Nala', 'Ziggy'])} {fake.last_name()}",
                f"{fake.first_name()} {fake.first_name()}",
            ]
        )

    def ip(self) -> tuple[str, str]:
        rng = self.rng
        if rng.random() < 0.2:
            groups = ["2a01", "2001", "2600", "2c0f"][rng.randrange(4)]
            text = (
                groups + ":" + ":".join(f"{rng.randint(0, 65535):x}" for _ in range(7))
            )
            return text, "ipv6"
        while True:
            first = rng.randint(1, 223)
            if first in (10, 100, 127, 169, 172, 192):
                continue
            text = ".".join(
                str(v) for v in [first] + [rng.randint(0, 255) for _ in range(3)]
            )
            if rng.random() < 0.3:
                text += f":{rng.choice([22, 443, 8080, 25565, 27015])}"
            return text, "ipv4"

    def national_id(self) -> tuple[str, str]:
        rng = self.rng
        if rng.random() < 0.7:
            area = rng.choice([a for a in range(1, 900) if a != 666])
            return (
                f"{area:03d}-{rng.randint(1, 99):02d}-{rng.randint(1, 9999):04d}",
                "us_ssn",
            )
        letters = "ABCEGHJKLMNPRSTWXYZ"
        prefix = rng.choice(letters[:-1]) + rng.choice(letters.replace("O", ""))
        digits = " ".join(f"{rng.randint(0, 99):02d}" for _ in range(3))
        return f"{prefix} {digits} {rng.choice('ABCD')}", "uk_nino"

    def iban(self) -> tuple[str, str]:
        rng = self.rng
        country, length = rng.choice(
            [("DE", 18), ("FR", 23), ("GB", 18), ("NL", 14), ("ES", 20)]
        )
        if country == "GB":
            bban = rng.choice(["NWBK", "BARC", "LOYD", "MIDL"]) + self.chars(
                string.digits, 14
            )
        elif country == "NL":
            bban = rng.choice(["ABNA", "INGB", "RABO"]) + self.chars(string.digits, 10)
        else:
            bban = self.chars(string.digits, length)
        numeric = "".join(str(int(ch, 36)) for ch in bban + country + "00")
        check = 98 - int(numeric) % 97
        compact = f"{country}{check:02d}{bban}"
        if rng.random() < 0.7:
            return " ".join(
                compact[i : i + 4] for i in range(0, len(compact), 4)
            ), country
        return compact, country

    # --- hard negatives ----------------------------------------------------------------
    def negative(self, category: str) -> str:
        rng, fake = self.rng, self.fake

        def word() -> str:
            return rng.choice(
                ["items", "users", "total", "count", "frame", "score", "queue"]
            )

        def user() -> str:
            return str(fake.user_name())

        if category == "code":
            return rng.choice(
                [
                    f"for (let i = 0; i < {word()}.length; i++) {{",
                    f"def get_{word()}(self, limit={rng.randint(1, 500)}):",
                    f"SELECT id, name FROM {word()} WHERE id = {rng.randint(1, 9999)};",
                    f"const {word()} = await fetch(url).then((r) => r.json());",
                    f"return {word()}.filter(x => x.active).map(x => x.id);",
                    f'git commit -m "fix: handle empty {word()}"',
                    f'if err != nil {{ return nil, fmt.Errorf("{word()}: %w", err) }}',
                ]
            )
        if category == "chat_mention":
            return rng.choice(
                [
                    f"{user()}: @{user()} gg that was insane",
                    f"@{user()} thanks for the raid!",
                    f"{user()}: thanks @{user()}. gg",
                    f"{user()}: lol @ {user()} missing that shot",
                ]
            )
        if category == "time_at":
            hour, minute = rng.randint(1, 12), rng.choice([0, 15, 30, 45])
            return rng.choice(
                [
                    f"lunch @ {hour}.{minute:02d}",
                    f"back @ {hour}:{minute:02d}",
                    f"stream starts @ {hour}pm",
                    f"raid @ {hour}.{minute:02d} tonight",
                ]
            )
        if category == "version":
            a, b, c, d = (rng.randint(0, 30) for _ in range(4))
            return rng.choice(
                [
                    f"v{a}.{b}.{c}",
                    f"v{a}.{b}.{c}.{d}",
                    f"version {a}.{b}.{c}.{d}",
                    f"build 10.0.{rng.randint(19000, 26300)}.{rng.randint(1, 5000)}",
                    f"Chrome/{rng.randint(100, 140)}.0.{rng.randint(4000, 7000)}.{rng.randint(1, 200)}",
                    f"OBS Studio {a % 32}.{b % 10}.{c % 10}",
                ]
            )
        if category == "private_ip":
            return rng.choice(
                [
                    f"192.168.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                    f"10.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                    f"172.{rng.randint(16, 31)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                    f"127.0.0.1:{rng.choice([3000, 8080, 47321])}",
                    "fe80::1",
                ]
            )
        if category == "date":
            date = fake.date_between(start_date="-3y", end_date="+1y")
            return rng.choice(
                [
                    date.isoformat(),
                    date.strftime("%d.%m.%Y"),
                    date.strftime("%m/%d/%Y")
                    + f" {rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}",
                    date.strftime("%d %b %Y"),
                    date.strftime("%a %d %b, ")
                    + f"{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}",
                ]
            )
        if category == "reference_number":
            return rng.choice(
                [
                    f"Order #{rng.randint(10**8, 10**10)}",
                    f"Invoice INV-{rng.randint(2019, 2026)}-{rng.randint(0, 99999):05d}",
                    f"Ticket {rng.randint(10**7, 10**8)}",
                    f"Steuernummer {rng.randint(10, 99)}/{rng.randint(100, 999)}/{rng.randint(10000, 99999)}",
                    f"Tracking 1Z{self.chars(string.ascii_uppercase + string.digits, 16)}",
                ]
            )
        if category == "non_luhn_16":
            while True:
                digits = "".join(str(rng.randint(0, 9)) for _ in range(16))
                total = sum(
                    (d * 2 - 9 if d >= 5 else d * 2) if i % 2 else d
                    for i, d in enumerate(int(ch) for ch in reversed(digits))
                )
                if total % 10:
                    break
            return rng.choice(
                [" ".join(digits[i : i + 4] for i in range(0, 16, 4)), digits]
            )
        if category == "scoreboard":
            return rng.choice(
                [
                    f"SCORE {rng.randint(100, 99999)}  |  FPS {rng.choice([60, 144, 240])}  |  ROUND {rng.randint(1, 30)}",
                    f"K/D/A {rng.randint(0, 30)}/{rng.randint(0, 20)}/{rng.randint(0, 25)}   {rng.randint(1000, 2000000):,} pts",
                    f"Rank #{rng.randint(1, 500)}  {rng.randint(1000, 4000)} SR",
                    f"HP {rng.randint(1, 2000)}/2000  MP {rng.randint(0, 500)}/500",
                ]
            )
        if category == "url":
            return rng.choice(
                [
                    f"https://{fake.domain_name()}/{fake.uri_path()}",
                    f"twitch.tv/{fake.user_name()}",
                    f"www.{fake.domain_name()}/docs/v{rng.randint(1, 9)}.{rng.randint(0, 9)}/index.html",
                    f"https://github.com/{fake.user_name()}/{word()}/pull/{rng.randint(1, 9999)}",
                ]
            )
        raise ValueError(category)

    def filler(self) -> str:
        return self.rng.choice(
            [
                "Notifications",
                "Last synced a few minutes ago",
                "Preferences saved",
                self.fake.sentence(nb_words=5),
                "Theme: dark",
                "Two-factor authentication enabled",
                self.fake.catch_phrase(),
            ]
        )


def sensitive(values: Values, kind: str, vault_term: str) -> tuple[str, str, str]:
    """Return (label, text, format) for one target value."""
    if kind == "email":
        text, fmt = values.email()
        return "Email", text, fmt
    if kind == "card":
        text, fmt, _ = values.card()
        return "Card number", text, fmt
    if kind == "secret":
        text, fmt = values.secret()
        return "", text, fmt
    if kind == "vault":
        return values.rng.choice(["Note", "From", "Re", ""]), vault_term, "vault"
    if kind == "phone":
        text, fmt = values.phone()
        return values.rng.choice(["Phone", "Mobile", "Tel.", ""]), text, fmt
    if kind == "address":
        text, fmt = values.address()
        return values.rng.choice(["Ship to", "Address", "Adresse", ""]), text, fmt
    if kind == "ip":
        text, fmt = values.ip()
        return values.rng.choice(["Server", "Your IP", "Connected to", ""]), text, fmt
    if kind == "national_id":
        text, fmt = values.national_id()
        return {"us_ssn": "SSN", "uk_nino": "NI number"}[fmt], text, fmt
    text, fmt = values.iban()
    return "IBAN", text, fmt


def span(text: str, attrs: str, style: str = "") -> str:
    return (
        f'<span {attrs} style="white-space:nowrap;{style}">{html.escape(text)}</span>'
    )


def build_screen(values: Values, index: int) -> tuple[str, dict[str, Any]]:
    """Compose one screen; return HTML and manifest fields (boxes filled in later)."""
    rng = values.rng
    family = rng.choice(FONTS)
    size = rng.choice([11, 13, 14, 16, 18, 22, 28])
    scale = rng.choice([1, 1.25, 1.5, 2]) if size <= 18 else rng.choice([1, 1.25])
    px = round(size * scale, 2)
    dark = rng.random() < 0.5
    roll = rng.random()
    screen_type = "negative" if roll < 0.3 else ("multi" if roll < 0.45 else "single")
    vault_terms = [values.vault_term() for _ in range(3)]
    targets: list[dict[str, Any]] = []
    negatives: list[dict[str, Any]] = []
    rows: list[str] = []
    gid = 0

    def label_html(label: str) -> str:
        return (
            f'<span style="color:#8a94a8;white-space:nowrap">{html.escape(label)}</span>'
            if label
            else ""
        )

    def negative_span() -> str:
        nonlocal gid
        category = rng.choice(NEGATIVE_CATEGORIES)
        gid += 1
        negatives.append({"id": f"g{gid}", "category": category})
        return span(values.negative(category), f'data-gt="g{gid}"')

    def target_span(kind: str) -> str:
        nonlocal gid
        label, text, fmt = sensitive(values, kind, vault_terms[0])
        gid += 1
        targets.append({"id": f"g{gid}", "kind": kind, "format": fmt})
        if kind == "card" and rng.random() < 0.25:
            # Split into separate input boxes, as on many checkout pages.
            digits = "".join(ch for ch in text if ch.isdigit())
            groups = (
                [digits[:4], digits[4:10], digits[10:]]
                if len(digits) == 15
                else [digits[i : i + 4] for i in range(0, 16, 4)]
            )
            targets[-1]["format"] += "-split-inputs"
            boxes = "".join(
                f'<span style="display:inline-block;border:1px solid #7a869c;border-radius:6px;padding:6px 10px;margin-right:{rng.randint(8, 22)}px">{g}</span>'
                for g in groups
            )
            value = f'<span data-gt="g{gid}" style="white-space:nowrap">{boxes}</span>'
        else:
            value = span(
                text,
                f'data-gt="g{gid}"',
                "filter:blur(.3px)" if rng.random() < 0.05 else "",
            )
        return f"{label_html(label)}{'&nbsp;&nbsp;' if label else ''}{value}"

    count = {"negative": 0, "single": 1, "multi": rng.randint(2, 3)}[screen_type]
    kinds = rng.sample(TARGET_KINDS, count) if count else []
    if "vault" not in kinds:
        vault_terms[0] = values.vault_term()
    entries = [("target", kind) for kind in kinds]
    entries += [("negative", "")] * rng.randint(2 if count else 3, 5)
    entries += [("filler", "")] * rng.randint(1, 3)
    rng.shuffle(entries)
    for role, kind in entries:
        if role == "target":
            cell = target_span(kind)
        elif role == "negative":
            cell = negative_span()
        else:
            cell = span(values.filler(), 'style="color:#94a3b8"')
        if role != "filler" and rng.random() < 0.35:
            # Same-row distractor beside the value, separated like a table column.
            gap = rng.randint(48, 160)
            cell = f'<div style="display:flex;gap:{gap}px;align-items:baseline">{cell}<span>{negative_span()}</span></div>'
        rows.append(f'<div style="margin:{rng.randint(10, 22)}px 0">{cell}</div>')
    bg, fg, panel = (
        ("#0d1220", "#f2f5ff", "#202b40") if dark else ("#eef2f8", "#101627", "#ffffff")
    )
    surface = rng.choice(SURFACES)
    left, top = rng.randint(40, 520), rng.randint(110, 260)
    page = (
        f'<!doctype html><html><meta charset="utf-8"><body style="margin:0;width:1920px;height:1080px;overflow:hidden;'
        f"background:{bg};color:{fg};font-family:'{family}'\">"
        f'<header style="padding:24px 28px;border-bottom:1px solid #64748b;font-size:22px">{html.escape(surface)}</header>'
        f'<aside style="position:absolute;left:0;top:90px;width:{left - 20}px;padding:20px;color:#8796ae;font-size:15px">'
        f"Home<br>Messages<br>Settings</aside>"
        f'<main style="position:absolute;left:{left}px;top:{top}px;padding:28px 32px;background:{panel};'
        f'border:1px solid #66728b;border-radius:12px;font-size:{px}px;max-width:{1880 - left}px">'
        + "".join(rows)
        + "</main></body></html>"
    )
    record = {
        "file": f"{index:05d}.{'jpg' if index % 3 == 0 else 'png'}",
        "screen_type": screen_type,
        "font": family,
        "font_size": size,
        "scale": scale,
        "theme": "dark" if dark else "light",
        "vault": vault_terms,
        "targets": targets,
        "negatives": negatives,
    }
    return page, record


BOXES_JS = """() => [...document.querySelectorAll('[data-gt]')].map(e => {
  const r = e.getBoundingClientRect();
  return {id: e.dataset.gt, x: r.x, y: r.y, width: r.width, height: r.height};
})"""


def ink_box(
    full: np.ndarray, hidden: np.ndarray, rect: dict[str, float]
) -> dict[str, float] | None:
    """Glyph bounding box: pixels inside the (padded) DOM box that change when text is hidden."""
    height, width = full.shape[:2]
    x0, y0 = max(0, int(rect["x"]) - 4), max(0, int(rect["y"]) - 4)
    x1 = min(width, int(rect["x"] + rect["width"]) + 5)
    y1 = min(height, int(rect["y"] + rect["height"]) + 5)
    if x1 <= x0 or y1 <= y0:
        return None
    diff = np.abs(
        full[y0:y1, x0:x1].astype(np.int16) - hidden[y0:y1, x0:x1].astype(np.int16)
    ).max(axis=2)
    ys, xs = np.nonzero(diff > 40)
    if len(xs) == 0:
        return None
    return {
        "x": float(x0 + xs.min()),
        "y": float(y0 + ys.min()),
        "width": float(xs.max() - xs.min() + 1),
        "height": float(ys.max() - ys.min() + 1),
    }


def render(jobs: list[tuple[str, dict[str, Any]]], output: str) -> list[dict[str, Any]]:
    """Render a chunk of screens in one browser; truth comes from a lossless panel diff."""
    folder = Path(output)
    records = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1920, "height": 1080}, device_scale_factor=1
        )
        for markup, record in jobs:
            page.set_content(markup)
            rects = {r["id"]: r for r in page.evaluate(BOXES_JS)}
            name = record["file"]
            index = int(name.split(".")[0])
            if name.endswith("jpg"):
                page.screenshot(
                    path=str(folder / name), type="jpeg", quality=75 + index % 20
                )
            else:
                page.screenshot(path=str(folder / name), type="png")
            region = page.evaluate(PANEL_JS)
            clip = {
                "x": max(0, region["x"] - 8),
                "y": max(0, region["y"] - 8),
                "width": min(1920.0, region["x"] + region["width"] + 8)
                - max(0, region["x"] - 8),
                "height": min(1080.0, region["y"] + region["height"] + 8)
                - max(0, region["y"] - 8),
            }
            visible = page.screenshot(type="png", clip=clip)
            page.add_style_tag(
                content="[data-gt], [data-gt] * { color: transparent !important; }"
            )
            hidden = page.screenshot(type="png", clip=clip)
            full = np.zeros((1080, 1920, 3), dtype=np.uint8)
            blank = np.zeros_like(full)
            x0, y0 = int(clip["x"]), int(clip["y"])
            for target, blob in ((full, visible), (blank, hidden)):
                pixels = np.asarray(Image.open(io.BytesIO(blob)).convert("RGB"))
                h, w = pixels.shape[:2]
                h, w = min(h, 1080 - y0), min(w, 1920 - x0)
                target[y0 : y0 + h, x0 : x0 + w] = pixels[:h, :w]
            for group in ("targets", "negatives"):
                kept = []
                for item in record[group]:
                    box = ink_box(full, blank, rects[item["id"]])
                    if box is not None:
                        kept.append({**item, "box": box})
                record[group] = kept
            records.append(record)
        browser.close()
    return records


PANEL_JS = """() => {
  const r = document.querySelector('main').getBoundingClientRect();
  return {x: r.x, y: r.y, width: r.width, height: r.height};
}"""


def generate(count: int, output: Path, seed: int, jobs: int = 2) -> None:
    """Save deterministic diverse fixtures and a JSONL manifest.

    Screens are composed sequentially from one seeded RNG, so the corpus does not depend on
    the number of rendering processes.
    """
    output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    values = Values(rng, seed)
    screens = [build_screen(values, i) for i in range(count)]
    size = max(1, -(-count // max(1, jobs * 2)))
    chunks = [screens[i : i + size] for i in range(0, count, size)]
    with ProcessPoolExecutor(max_workers=max(1, jobs)) as pool:
        results = list(pool.map(render, chunks, [str(output)] * len(chunks)))
    records = [record for chunk in results for record in chunk]
    (output / "manifest.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=3000)
    parser.add_argument("--output", type=Path, default=Path("bench/data"))
    parser.add_argument("--seed", type=int, default=7319)
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    generate(args.count, args.output, args.seed, args.jobs)
