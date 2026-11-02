"""Hard negatives from bench/generate.py must not be flagged; recall cases must still be."""

import pytest
from veil_detector.numeric_rescue import card_layout, rescue_accepted
from veil_detector.recognizers import recognize


def kinds(text: str) -> set[str]:
    return {kind for kind, _ in recognize(text, [])}


@pytest.mark.parametrize(
    "text",
    [
        # code
        "for (let i = 0; i < items.length; i++) {",
        "def get_users(self, limit=250):",
        "SELECT id, name FROM queue WHERE id = 8812;",
        "const total = await fetch(url).then((r) => r.json());",
        'git commit -m "fix: handle empty frame"',
        'if err != nil { return nil, fmt.Errorf("score: %w", err) }',
        # chat mentions
        "pixelfox: @nightowl92 gg that was insane",
        "@sneaky_pete thanks for the raid!",
        "mod_bot: thanks @luna.gg. gg",
        "kappa_king: lol @ zed missing that shot",
        # times
        "lunch @ 12.30",
        "back @ 7:45",
        "stream starts @ 9pm",
        "raid @ 11.15 tonight",
        # versions
        "v12.4.27",
        "v3.14.15.9",
        "version 4.18.2.0",
        "build 10.0.22631.4317",
        "Chrome/131.0.6778.86",
        "OBS Studio 30.2.3",
        # private IPs
        "192.168.1.254",
        "10.0.12.7",
        "172.20.3.44",
        "127.0.0.1:47321",
        "fe80::1",
        # dates
        "2025-03-14",
        "14.03.2025",
        "03/14/2025 21:07",
        "14 Mar 2025",
        "Fri 14 Mar, 21:07",
        # reference numbers
        "Order #4155550123",
        "Order #2025550143",
        "Invoice INV-2024-00417",
        "Ticket 20255501",
        "Steuernummer 21/815/08150",
        "Tracking 1Z999AA10123456784",
        # scoreboards
        "SCORE 41255  |  FPS 144  |  ROUND 12",
        "K/D/A 12/3/9   1,402,311 pts",
        "Rank #42  3120 SR",
        "HP 1450/2000  MP 120/500",
        # URLs
        "https://example.com/app/category/list",
        "twitch.tv/nightowl92",
        "www.example.org/docs/v2.4/index.html",
        "https://github.com/nightowl92/items/pull/4155",
        # bare national numbers with no phone context
        "2025550143",
        "020 7946 0018",
        "viewers 4155550123",
    ],
)
def test_hard_negative_not_flagged(text: str) -> None:
    assert kinds(text) == set(), text


@pytest.mark.parametrize("text", ["4111 1111 1111 1112", "4111111111111112", "1234-5678-9012-3450"])
def test_non_luhn_16_not_flagged(text: str) -> None:
    assert "card" not in kinds(text)


@pytest.mark.parametrize(
    "text",
    [
        "+1 415-555-0132",
        "+44 20 7946 0018",
        "+4915123456789",
        "Phone  (415) 555-0132",
        "Mobile  07400 123456",
        "Tel.  030 12345678",
        "call me at 020 7946 0018",
        "Phone  01 23 45 67 89",
    ],
)
def test_phone_recall(text: str) -> None:
    assert "phone" in kinds(text), text


@pytest.mark.parametrize(
    "text",
    [
        "Order phone 4155550132",
        "Tracking +1 415 555 0132",
        "Invoice no. tel 020 7946 0018",
        "Tax ID phone 030 12345678",
    ],
)
def test_phone_vetoed_by_reference_context(text: str) -> None:
    assert "phone" not in kinds(text), text


@pytest.mark.parametrize(
    "text", ["Card number  4111 1111 1111 1111", "4111-1111-1111-1111", "378282246310005"]
)
def test_card_recall(text: str) -> None:
    assert "card" in kinds(text)


def test_card_layout() -> None:
    assert card_layout("4111 1111 1111 1111")
    assert card_layout("3782-822463-10005")
    assert card_layout("Card 4111-1111-1111-1111")
    assert not card_layout("4111111111111111")
    assert not card_layout("Order #4111 1111")
    assert not card_layout("41 11 11 11 11 11 11 11")


@pytest.mark.parametrize(
    "originals,rescued,expected",
    [
        # One misread digit on a card-shaped line is corrected.
        (["4111 1111 1111 1112"], "4111 1111 1111 1111", True),
        (["4111 1111 1111 1171"], "4111111111111111", True),
        # Amex layout.
        (["3782 822463 10006"], "378282246310005", True),
        # A missed span is accepted only if the re-read is card-shaped.
        ([], "4111 1111 1111 1111", True),
        ([], "4111111111111111", False),
        # Contiguous non-Luhn numbers are not card-like; no rescue.
        (["4111111111111112"], "4111111111111111", False),
        (["Order 9876543210123456"], "9876 5432 1012 3457", False),
        # Too many changed digits.
        (["4111 1111 1111 1999"], "4111 1111 1111 1111", False),
        # Inventing a digit (15 -> 16) is never accepted.
        (["4111 1111 1111 111"], "4111 1111 1111 1111", False),
        # The rescue must still pass Luhn.
        (["4111 1111 1111 1112"], "4111 1111 1111 1113", False),
    ],
)
def test_rescue_accepted(originals: list[str], rescued: str, expected: bool) -> None:
    assert rescue_accepted(originals, rescued) is expected
