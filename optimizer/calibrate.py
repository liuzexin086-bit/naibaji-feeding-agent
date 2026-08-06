"""Growth-only ADG calibration for feeding-parameters-v3.

P1 only calibrates growth knobs that can be identified from repeated live
weight samples. Diarrhea sensitivity is deliberately NOT calibrated here; that
work is deferred to NBJ-ML-P4 and requires explicit diarrhea labels.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Iterable

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from contracts import PARAM_DEFAULT, FeedingParametersV3
from model import WEIGHT_STANDARD, diff_forward

KNOB_NAMES = ["scaleFactor", "peakAdjust"]
KNOB_RANGE = {
    "scaleFactor": (0.90, 1.10),
    "peakAdjust": (-0.05, 0.05),
}
KNOB_DEFAULT = np.array([1.0, 0.0])
MIN_ELIGIBLE_BATCHES = 3
CALIBRATION_SCHEMA_VERSION = "growth-calibration-candidate-v1"


def apply_knobs(theta_base: np.ndarray, knobs: np.ndarray) -> np.ndarray:
    """Apply only growth-identifiable knobs to the V3 parameter vector."""
    if len(knobs) != len(KNOB_NAMES):
        raise ValueError("NBJ_CALIBRATION_KNOB_SCHEMA_MISMATCH")
    theta = theta_base.copy()
    theta[0] = theta[0] * float(knobs[0])
    theta[1] = theta[1] * float(knobs[0])
    theta[2] = float(np.clip(theta[2] * float(knobs[0]) + float(knobs[1]), 0.62, 0.92))
    return theta


def measured_weight_points(batch: dict) -> list[tuple[int, float]]:
    points: list[tuple[int, float]] = []
    for record in batch.get("records", []):
        sample = record.get("weighSample")
        if not isinstance(sample, list) or not sample:
            continue
        total_weight = 0.0
        total_count = 0
        for row in sample:
            if not isinstance(row, dict):
                continue
            avg_kg = row.get("avgKg")
            head_count = row.get("headCount")
            if isinstance(avg_kg, (int, float)) and isinstance(head_count, (int, float)):
                total_weight += float(avg_kg) * float(head_count)
                total_count += float(head_count)
        if total_count > 0 and total_weight > 0:
            points.append((int(record["dayAge"]), total_weight / total_count))
    return points


def _excluded_reason(batch: dict, points: list[tuple[int, float]]) -> str | None:
    if len(points) < 2:
        return "fewer_than_two_valid_weight_points"
    first = points[0]
    last = points[-1]
    days = last[0] - first[0]
    if days <= 0:
        return "non_positive_time_span"
    if first[1] <= 0 or last[1] <= 0:
        return "non_positive_weight"
    return None


def predict_error(
    knobs: np.ndarray,
    batches: Iterable[dict],
    theta_base: np.ndarray,
) -> dict:
    """Mean squared ADG error over eligible batches only.

    A batch is eligible only when it has at least two valid weight samples and
    a positive time span. If fewer than MIN_ELIGIBLE_BATCHES batches qualify,
    calibration fails closed instead of returning an overfit default.
    """

    error_sum = 0.0
    eligible_count = 0
    excluded: list[dict] = []
    for batch in batches:
        points = measured_weight_points(batch)
        reason = _excluded_reason(batch, points)
        if reason:
            excluded.append({"batchId": str(batch.get("id", "")), "reason": reason})
            continue
        theta = apply_knobs(theta_base, knobs)
        prediction = diff_forward(FeedingParametersV3.from_vector(theta), batch)
        first = points[0]
        last = points[-1]
        days = last[0] - first[0]
        actual_adg = (last[1] - first[1]) / days * 1000
        error_sum += (prediction["adg"] - actual_adg) ** 2
        eligible_count += 1

    if eligible_count < MIN_ELIGIBLE_BATCHES:
        raise ValueError(
            "NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA: "
            f"eligible_batches={eligible_count}, required={MIN_ELIGIBLE_BATCHES}"
        )
    return {
        "status": "candidate",
        "error": error_sum / eligible_count,
        "eligibleBatchCount": eligible_count,
        "excludedReasons": excluded,
    }


def gen_farm_with_weights(
    n: int = 8,
    farm_bias: dict | None = None,
    seed: int = 789,
) -> tuple[list[dict], np.ndarray, dict]:
    rng = np.random.default_rng(seed)
    if farm_bias is None:
        farm_bias = {"scaleFactor": 0.95, "peakAdjust": -0.02}
    theta_true = apply_knobs(
        PARAM_DEFAULT,
        np.array([farm_bias["scaleFactor"], farm_bias["peakAdjust"]]),
    )

    batches: list[dict] = []
    for index in range(n):
        sa = int(rng.integers(3, 8))
        ea = int(rng.integers(21, 25))
        hc = int(rng.integers(8, 20))
        sw = round(WEIGHT_STANDARD.get(sa, 2.3) + rng.uniform(-0.2, 0.2), 2)

        creep_values = [
            max(0, d * rng.uniform(1.5, 4))
            for d in range(ea - sa + 1)
        ]
        dummy_batch = {
            "startAge": sa,
            "endAge": ea,
            "startWeight": sw,
            "headCount": hc,
            "records": [],
        }
        for d in range(ea - sa + 1):
            dummy_batch["records"].append(
                {
                    "dayAge": sa + d,
                    "totalCreepG": int(creep_values[d] * hc),
                    "headCount": hc,
                }
            )

        true_result = diff_forward(FeedingParametersV3.from_vector(theta_true), dummy_batch)
        records: list[dict] = []
        weigh_days = [0, (ea - sa) // 2, ea - sa]
        for d in range(ea - sa + 1):
            day_age = sa + d
            cp = creep_values[d]
            record: dict = {
                "dayAge": day_age,
                "totalMilkG": int(true_result["dailyMilk"][d] * hc * (1 + rng.normal(0, 0.03))),
                "totalCreepG": int(cp * hc),
                "headCount": hc,
                "diarrheaMild": 0,
                "diarrheaModerate": 0,
                "diarrheaSevere": 0,
            }
            if d in weigh_days:
                true_weight = true_result["dailyWeight"][d]
                record["weighSample"] = [
                    {
                        "category": "all",
                        "avgKg": round(true_weight * (1 + rng.normal(0, 0.001)), 2),
                        "headCount": hc,
                    },
                ]
            records.append(record)

        batches.append(
            {
                "id": f"farm-{index}",
                "startAge": sa,
                "endAge": ea,
                "startWeight": sw,
                "headCount": hc,
                "records": records,
            }
        )

    return batches, theta_true, farm_bias


def grid_search(
    batches: list[dict],
    theta_base: np.ndarray,
    grid_steps: int = 11,
) -> tuple[np.ndarray, dict]:
    best_knobs = KNOB_DEFAULT.copy()
    best_result = predict_error(best_knobs, batches, theta_base)
    best_error = float(best_result["error"])

    for scale_factor in np.linspace(*KNOB_RANGE["scaleFactor"], grid_steps):
        for peak_adjust in np.linspace(*KNOB_RANGE["peakAdjust"], grid_steps):
            knobs = np.array([scale_factor, peak_adjust])
            result = predict_error(knobs, batches, theta_base)
            if float(result["error"]) < best_error:
                best_error = float(result["error"])
                best_knobs = knobs.copy()
                best_result = result

    return best_knobs, best_result


def build_calibration_candidate(
    knobs: np.ndarray,
    result: dict,
    *,
    farm_bias: dict,
    batches: list[dict],
) -> dict:
    return {
        "schemaVersion": CALIBRATION_SCHEMA_VERSION,
        "status": "candidate",
        "validForProduction": False,
        "applied": False,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "knobNames": KNOB_NAMES,
        "knobDefault": KNOB_DEFAULT.tolist(),
        "knobCandidate": knobs.tolist(),
        "trueBias": farm_bias,
        "eligibleBatchCount": result["eligibleBatchCount"],
        "excludedReasons": result["excludedReasons"],
        "error": result["error"],
    }


def main() -> None:
    print("=" * 60)
    print("奶爸机 — 生长校准（仅 scaleFactor / peakAdjust）")
    print("=" * 60)

    smoke = os.environ.get("NBJ_OPTIMIZER_SMOKE") == "1"
    farm_bias = {"scaleFactor": 0.95, "peakAdjust": -0.02}
    batches, theta_true, _ = gen_farm_with_weights(n=8, farm_bias=farm_bias)
    print(f"\n场区真实生长偏差: scaleFactor={farm_bias['scaleFactor']}, peakAdjust={farm_bias['peakAdjust']}")
    print(f"数据: {len(batches)} 批")

    default_result = predict_error(KNOB_DEFAULT, batches, PARAM_DEFAULT)
    print(f"\n默认参数预测误差: {default_result['error']:.4f}，有效批次 {default_result['eligibleBatchCount']}")

    grid_steps = 3 if smoke else 11
    print(f"\n网格搜索 {grid_steps}×{grid_steps} = {grid_steps ** 2} 次评估...")
    best_knobs, best_result = grid_search(batches, PARAM_DEFAULT, grid_steps=grid_steps)
    improvement = (default_result["error"] - best_result["error"]) / default_result["error"] * 100
    print(f"\n最优候选: 误差 {default_result['error']:.4f} → {best_result['error']:.4f} ({improvement:.0f}% 降低)")

    print(f"\n{'旋钮':>12} {'默认':>8} {'候选':>8} {'真值':>8}")
    for index, name in enumerate(KNOB_NAMES):
        print(
            f"{name:>12} {KNOB_DEFAULT[index]:>8.3f} {best_knobs[index]:>8.3f} "
            f"{farm_bias[name]:>8.3f}"
        )

    candidate = build_calibration_candidate(
        best_knobs,
        best_result,
        farm_bias=farm_bias,
        batches=batches,
    )
    if not smoke:
        path = os.path.join(os.path.dirname(__file__), "growth_calibration_candidate.json")
        with open(path, "w", encoding="utf-8") as file:
            json.dump(candidate, file, ensure_ascii=False, indent=2)
        print("\n结果仅作为 candidate 保存，不会覆盖默认参数或写入生产模型。")
        print(f"  文件: {path}")


if __name__ == "__main__":
    main()
