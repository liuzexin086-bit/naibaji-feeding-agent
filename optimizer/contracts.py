"""Single source of truth for the V3 feeding parameter contract."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

SCHEMA_VERSION = "feeding-parameters-v3"
PARAMETER_SCHEMA_MISMATCH_CODE = "NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH"

FIELD_ORDER = (
    "baseLevel",
    "ramp",
    "peakLevel",
    "threshold",
    "dilution",
    "diarrheaSensitivity",
)
FIELD_UNITS = {
    "baseLevel": "ratio",
    "ramp": "ratio",
    "peakLevel": "ratio",
    "threshold": "grams-per-head",
    "dilution": "water-to-powder ratio",
    "diarrheaSensitivity": "dimensionless",
}
FIELD_RANGES = {
    "baseLevel": (0.18, 0.40),
    "ramp": (0.15, 0.50),
    "peakLevel": (0.68, 0.92),
    "threshold": (150, 220),
    "dilution": (5, 8),
    "diarrheaSensitivity": (0.3, 2.0),
}
FIELD_DEFAULTS = {
    "baseLevel": 0.28,
    "ramp": 0.40,
    "peakLevel": 0.82,
    "threshold": 180,
    "dilution": 6,
    "diarrheaSensitivity": 1.0,
}

# Compatibility aliases kept inside the contract so callers never define a
# second parameter table.
PARAM_NAMES = FIELD_ORDER
PARAM_RANGE = dict(FIELD_RANGES)
PARAM_DEFAULT = np.array([FIELD_DEFAULTS[name] for name in FIELD_ORDER], dtype=float)


def parameter_schema_mismatch(message: str) -> ValueError:
    return ValueError(f"{PARAMETER_SCHEMA_MISMATCH_CODE}: {message}")


def _validated_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.number)):
        raise parameter_schema_mismatch(f"{name} must be a finite number")
    numeric = float(value)
    if not np.isfinite(numeric):
        raise parameter_schema_mismatch(f"{name} must be finite")
    low, high = FIELD_RANGES[name]
    if numeric < low or numeric > high:
        raise parameter_schema_mismatch(
            f"{name}={numeric} is outside [{low}, {high}]"
        )
    return numeric


@dataclass(frozen=True, slots=True)
class FeedingParametersV3:
    """Immutable V3 production parameter contract.

    Field order is fixed for vector conversion and must never be mixed with
    the legacy seven-parameter optimizer schema.
    """

    baseLevel: float
    ramp: float
    peakLevel: float
    threshold: float
    dilution: float
    diarrheaSensitivity: float
    schemaVersion: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schemaVersion != SCHEMA_VERSION:
            raise parameter_schema_mismatch(
                f"unsupported schemaVersion {self.schemaVersion!r}"
            )
        for name in FIELD_ORDER:
            object.__setattr__(
                self,
                name,
                _validated_float(getattr(self, name), name),
            )

    @classmethod
    def from_mapping(
        cls,
        mapping: Mapping[str, Any],
        *,
        schema_version: str = SCHEMA_VERSION,
    ) -> "FeedingParametersV3":
        if not mapping or not isinstance(mapping, Mapping):
            raise parameter_schema_mismatch("mapping must be a non-empty object")
        if "schemaVersion" in mapping and mapping["schemaVersion"] != schema_version:
            raise parameter_schema_mismatch(
                f"schemaVersion mismatch: {mapping['schemaVersion']!r}"
            )
        values = mapping.get("parameters", mapping)
        if not isinstance(values, Mapping):
            raise parameter_schema_mismatch("parameters must be an object")
        allowed = set(FIELD_ORDER) | {"schemaVersion"}
        unknown = set(values) - allowed
        if unknown:
            raise parameter_schema_mismatch(
                f"unknown fields: {', '.join(sorted(unknown))}"
            )
        missing = [name for name in FIELD_ORDER if name not in values]
        if missing:
            raise parameter_schema_mismatch(
                f"missing fields: {', '.join(missing)}"
            )
        if "schemaVersion" in values and values["schemaVersion"] != schema_version:
            raise parameter_schema_mismatch(
                f"schemaVersion mismatch: {values['schemaVersion']!r}"
            )
        return cls(
            baseLevel=values["baseLevel"],
            ramp=values["ramp"],
            peakLevel=values["peakLevel"],
            threshold=values["threshold"],
            dilution=values["dilution"],
            diarrheaSensitivity=values["diarrheaSensitivity"],
            schemaVersion=schema_version,
        )

    @classmethod
    def from_vector(
        cls,
        vector: Sequence[float],
        *,
        schema_version: str = SCHEMA_VERSION,
    ) -> "FeedingParametersV3":
        if isinstance(vector, FeedingParametersV3):
            return vector
        values = list(vector)
        if len(values) == 7:
            raise parameter_schema_mismatch(
                "legacy 7-parameter vector rejected; expected "
                "feeding-parameters-v3 with 6 named fields"
            )
        if len(values) != len(FIELD_ORDER):
            raise parameter_schema_mismatch(
                f"expected {len(FIELD_ORDER)} fields, got {len(values)}"
            )
        return cls(
            baseLevel=values[0],
            ramp=values[1],
            peakLevel=values[2],
            threshold=values[3],
            dilution=values[4],
            diarrheaSensitivity=values[5],
            schemaVersion=schema_version,
        )

    @classmethod
    def defaults(cls) -> "FeedingParametersV3":
        return cls.from_mapping(FIELD_DEFAULTS)

    def to_mapping(self, *, include_units: bool = True) -> dict[str, Any]:
        mapping: dict[str, Any] = {
            "schemaVersion": self.schemaVersion,
            "parameters": {
                name: getattr(self, name) for name in FIELD_ORDER
            },
        }
        if include_units:
            mapping["units"] = dict(FIELD_UNITS)
        return mapping

    def to_vector(self) -> np.ndarray:
        return np.array([getattr(self, name) for name in FIELD_ORDER], dtype=float)


def coerce_parameters(value: Any) -> FeedingParametersV3:
    if isinstance(value, FeedingParametersV3):
        return value
    if isinstance(value, Mapping):
        return FeedingParametersV3.from_mapping(value)
    if isinstance(value, (Sequence, np.ndarray)):
        return FeedingParametersV3.from_vector(value)
    raise parameter_schema_mismatch(
        "parameters must be FeedingParametersV3, a mapping, or a vector"
    )
