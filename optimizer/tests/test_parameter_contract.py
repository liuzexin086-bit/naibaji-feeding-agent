import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contracts import (
    FIELD_DEFAULTS,
    FIELD_ORDER,
    FIELD_UNITS,
    SCHEMA_VERSION,
    FeedingParametersV3,
    coerce_parameters,
)


class FeedingParametersContractTest(unittest.TestCase):
    def test_default_parameters_round_trip(self) -> None:
        params = FeedingParametersV3.defaults()
        self.assertEqual(params.schemaVersion, SCHEMA_VERSION)
        self.assertEqual(
            params.to_mapping(),
            {
                "schemaVersion": SCHEMA_VERSION,
                "parameters": dict(FIELD_DEFAULTS),
                "units": dict(FIELD_UNITS),
            },
        )
        self.assertTrue(np.allclose(params.to_vector(), np.array(list(FIELD_DEFAULTS.values()))))
        self.assertEqual(FeedingParametersV3.from_vector(params.to_vector()), params)
        self.assertEqual(FeedingParametersV3.from_mapping(params.to_mapping()), params)

    def test_six_fields_map_individually(self) -> None:
        values = {
            "baseLevel": 0.25,
            "ramp": 0.35,
            "peakLevel": 0.80,
            "threshold": 190,
            "dilution": 7,
            "diarrheaSensitivity": 1.25,
        }
        params = FeedingParametersV3.from_mapping(values)
        for name in FIELD_ORDER:
            self.assertEqual(getattr(params, name), values[name])
            self.assertEqual(FIELD_UNITS[name], params.to_mapping()["units"][name])

    def test_legacy_seven_parameter_vector_is_rejected(self) -> None:
        legacy = np.array([0.30, 0.60, 0.78, 0.85, 0.90, 0.70, 180])
        with self.assertRaisesRegex(ValueError, "NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH"):
            FeedingParametersV3.from_vector(legacy)
        with self.assertRaisesRegex(ValueError, "NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH"):
            coerce_parameters(legacy)

    def test_short_long_nonfinite_and_out_of_range_vectors_are_rejected(self) -> None:
        valid = np.array([0.28, 0.40, 0.82, 180, 6, 1.0])
        for vector in (valid[:5], np.append(valid, 1.0), [0.28, 0.40, 0.82, 180, 6]):
            with self.assertRaisesRegex(ValueError, "NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH"):
                FeedingParametersV3.from_vector(vector)
        for bad in (
            [0.28, 0.40, 0.82, 180, 6, math.nan],
            [0.28, 0.40, 0.82, 180, 6, math.inf],
            [0.28, 0.40, 0.82, 180, 6, -1],
            [0.28, 0.40, 0.82, 180, 6, 3.0],
        ):
            with self.assertRaisesRegex(ValueError, "NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH"):
                FeedingParametersV3.from_vector(bad)

    def test_mapping_rejects_unknown_and_missing_fields(self) -> None:
        values = dict(FIELD_DEFAULTS)
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            FeedingParametersV3.from_mapping({**values, "D1": 0.3})
        with self.assertRaisesRegex(ValueError, "missing fields"):
            FeedingParametersV3.from_mapping({name: value for name, value in values.items() if name != "ramp"})
        with self.assertRaisesRegex(ValueError, "schemaVersion mismatch"):
            FeedingParametersV3.from_mapping({**values, "schemaVersion": "legacy-v1"})
        with self.assertRaisesRegex(ValueError, "schemaVersion mismatch"):
            FeedingParametersV3.from_mapping({
                "schemaVersion": "legacy-v1",
                "parameters": values,
            })


if __name__ == "__main__":
    unittest.main()
