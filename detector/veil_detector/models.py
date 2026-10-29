"""Validated wire contracts. Text is never part of a detection response."""

from typing import Literal, cast
from pydantic import BaseModel, Field, model_validator

Kind = Literal["email", "phone", "card", "ip", "address", "secret", "vault", "window"]


class Box(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def bounds(self) -> "Box":
        """Reject rectangles extending beyond the frame."""
        if self.x + self.w > 1.00001 or self.y + self.h > 1.00001:
            raise ValueError("box outside frame")
        return self


class Detection(BaseModel):
    track_id: str = ""
    kind: Kind
    box: Box
    confidence: float = Field(ge=0, le=1)
    text_hash: str
    first_seen_frame: int = Field(ge=0)


class DetectionResult(BaseModel):
    frame_id: int
    processed_ms: float
    detections: list[Detection]


class Policy(BaseModel):
    profile: Literal["off", "balanced", "paranoid"] = "paranoid"
    hold_ms: int = Field(default=1500, ge=0, le=10000)
    thresholds: dict[str, float] = Field(default_factory=dict)
    enabled: list[Kind] = Field(
        default_factory=lambda: cast(
            list[Kind],
            [
                "email",
                "phone",
                "card",
                "ip",
                "address",
                "secret",
                "vault",
                "window",
            ],
        )
    )
    ignore_zones: list[Box] = Field(default_factory=list)
    denylist: list[str] = Field(
        default_factory=lambda: [
            "1password",
            "bitwarden",
            "keepass",
            "lastpass",
            "dashlane",
            "credential manager",
            "keychain access",
            "outlook",
            "thunderbird",
            "gmail",
            "proton mail",
        ]
    )


class VaultUpdate(BaseModel):
    terms: list[str] = Field(max_length=1000)
