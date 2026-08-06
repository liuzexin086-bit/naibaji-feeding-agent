import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from calibrate import (
    KNOB_DEFAULT,
    KNOB_NAMES,
    MIN_ELIGIBLE_BATCHES,
    build_calibration_candidate,
    gen_farm_with_weights,
    grid_search,
    predict_error,
)
from contracts import PARAM_DEFAULT


def batch_with_weights(day_ages=(3, 4), weights=(2.3, 2.5), batch_id="b"):
    records = [
        {
            "dayAge": day_age,
            "weighSample": [{"avgKg": weight, "headCount": 10}],
        }
        for day_age, weight in zip(day_ages, weights)
    ]
    return {
        "id": batch_id,
        "startAge": day_ages[0],
        "endAge": day_ages[-1],
        "startWeight": weights[0],
        "headCount": 10,
        "records": records,
    }


class CalibrationIdentifiabilityTest(unittest.TestCase):
    def test_growth_calibration_has_no_diar_offset(self) -> None:
        self.assertEqual(KNOB_NAMES, ["scaleFactor", "peakAdjust"])
        batches, _, farm_bias = gen_farm_with_weights(n=4, seed=3)
        knobs, result = grid_search(batches, PARAM_DEFAULT, grid_steps=5)
        candidate = build_calibration_candidate(
            knobs,
            result,
            farm_bias=farm_bias,
            batches=batches,
        )
        self.assertNotIn("diarOffset", candidate["knobNames"])
        self.assertEqual(candidate["status"], "candidate")
        self.assertFalse(candidate["validForProduction"])
        self.assertFalse(candidate["applied"])

    def test_insufficient_weight_data_fails_closed(self) -> None:
        no_weights = {
            "id": "none",
            "startAge": 3,
            "endAge": 5,
            "startWeight": 2.3,
            "headCount": 10,
            "records": [],
        }
        with self.assertRaisesRegex(ValueError, "NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA"):
            predict_error(KNOB_DEFAULT, [no_weights], PARAM_DEFAULT)

        one_point = batch_with_weights([3], [2.3])
        with self.assertRaisesRegex(ValueError, "NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA"):
            predict_error(KNOB_DEFAULT, [one_point], PARAM_DEFAULT)

        zero_span = batch_with_weights([3, 3], [2.3, 2.4])
        with self.assertRaisesRegex(ValueError, "NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA"):
            predict_error(KNOB_DEFAULT, [zero_span], PARAM_DEFAULT)

    def test_denominator_uses_only_eligible_batches(self) -> None:
        valid = [
            batch_with_weights((3, 5), (2.3, 2.8), f"valid-{index}")
            for index in range(MIN_ELIGIBLE_BATCHES + 1)
        ]
        invalid = [
            batch_with_weights((3,), (2.3,), f"invalid-{index}")
            for index in range(2)
        ]
        result = predict_error(KNOB_DEFAULT, [*valid, *invalid], PARAM_DEFAULT)
        self.assertEqual(result["eligibleBatchCount"], MIN_ELIGIBLE_BATCHES + 1)
        self.assertEqual(len(result["excludedReasons"]), 2)
        self.assertTrue(
            all(item["reason"] == "fewer_than_two_valid_weight_points" for item in result["excludedReasons"])
        )

        expected_error = 0.0
        for batch in valid:
            points = []
            for record in batch["records"]:
                points.append((record["dayAge"], record["weighSample"][0]["avgKg"]))
            days = points[-1][0] - points[0][0]
            actual_adg = (points[-1][1] - points[0][1]) / days * 1000
            from calibrate import apply_knobs
            from model import diff_forward

            theta = apply_knobs(PARAM_DEFAULT, KNOB_DEFAULT)
            predicted = diff_forward(theta, batch)["adg"]
            expected_error += (predicted - actual_adg) ** 2
        self.assertAlmostEqual(result["error"], expected_error / len(valid))

    def test_synthetic_data_recovers_growth_knobs_and_is_stable(self) -> None:
        bias = {"scaleFactor": 0.96, "peakAdjust": -0.01}
        first, _, _ = gen_farm_with_weights(n=6, farm_bias=bias, seed=42)
        second, _, _ = gen_farm_with_weights(n=6, farm_bias=bias, seed=42)
        self.assertEqual(first, second)

        knobs, result = grid_search(first, PARAM_DEFAULT, grid_steps=9)
        self.assertGreaterEqual(result["eligibleBatchCount"], MIN_ELIGIBLE_BATCHES)
        self.assertAlmostEqual(float(knobs[0]), bias["scaleFactor"], delta=0.03)
        self.assertAlmostEqual(float(knobs[1]), bias["peakAdjust"], delta=0.02)


if __name__ == "__main__":
    unittest.main()
