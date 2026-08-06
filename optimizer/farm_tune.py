"""Growth-only field tuning for feeding-parameters-v3.

The tuner adjusts only scaleFactor and peakAdjust. Diarrhea sensitivity is
not identifiable from ADG weight data alone and is deliberately excluded.
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from contracts import PARAM_DEFAULT, FeedingParametersV3
from model import WEIGHT_STANDARD, diff_forward

KNOB_NAMES = ["scaleFactor", "peakAdjust"]
KNOB_RANGE = {
    "scaleFactor": (0.88, 1.12),
    "peakAdjust": (-0.06, 0.06),
}
KNOB_DEFAULT = np.array([1.0, 0.0])


def apply_knobs(theta_base: np.ndarray, knobs: np.ndarray) -> np.ndarray:
    if len(knobs) != len(KNOB_NAMES):
        raise ValueError("NBJ_CALIBRATION_KNOB_SCHEMA_MISMATCH")
    theta = theta_base.copy()
    theta[0] = theta[0] * float(knobs[0])
    theta[1] = theta[1] * float(knobs[0])
    theta[2] = float(np.clip(theta[2] * float(knobs[0]) + float(knobs[1]), 0.60, 0.92))
    return theta


def score(knobs: np.ndarray, batches: list[dict], theta_base: np.ndarray) -> float:
    """ADG-only objective; no diarrhea proxy is used for growth calibration."""
    theta = apply_knobs(theta_base, knobs)
    adg_total = 0.0
    for batch in batches:
        result = diff_forward(FeedingParametersV3.from_vector(theta), batch)
        adg_total += float(result["adg"])
    return -adg_total / max(len(batches), 1)


def nelder_mead(
    function,
    x0: np.ndarray,
    bounds: list[tuple[float, float]],
    max_iter: int = 200,
    tol: float = 1e-6,
    alpha: float = 1.0,
    gamma: float = 2.0,
    rho: float = 0.5,
    sigma: float = 0.5,
) -> tuple[np.ndarray, float, list[dict]]:
    dimension = len(x0)
    simplex = [x0.copy()]
    for index in range(dimension):
        candidate = x0.copy()
        candidate[index] = float(np.clip(candidate[index] * 1.05, *bounds[index]))
        if candidate[index] == x0[index]:
            candidate[index] = float(np.clip(x0[index] + 0.01, *bounds[index]))
        simplex.append(candidate)
    values = [function(item) for item in simplex]
    history: list[dict] = []

    for iteration in range(max_iter):
        order = np.argsort(values)
        simplex = [simplex[index] for index in order]
        values = [values[index] for index in order]
        centroid = np.mean(simplex[:-1], axis=0)

        reflected = centroid + alpha * (centroid - simplex[-1])
        reflected = np.clip(reflected, [item[0] for item in bounds], [item[1] for item in bounds])
        reflected_value = function(reflected)

        if reflected_value < values[0]:
            expanded = centroid + gamma * (reflected - centroid)
            expanded = np.clip(expanded, [item[0] for item in bounds], [item[1] for item in bounds])
            expanded_value = function(expanded)
            if expanded_value < reflected_value:
                simplex[-1] = expanded
                values[-1] = expanded_value
            else:
                simplex[-1] = reflected
                values[-1] = reflected_value
        elif reflected_value < values[-2]:
            simplex[-1] = reflected
            values[-1] = reflected_value
        else:
            contracted = centroid + rho * (simplex[-1] - centroid)
            contracted = np.clip(contracted, [item[0] for item in bounds], [item[1] for item in bounds])
            contracted_value = function(contracted)
            if contracted_value < values[-1]:
                simplex[-1] = contracted
                values[-1] = contracted_value
            else:
                for index in range(1, dimension + 1):
                    simplex[index] = simplex[0] + sigma * (simplex[index] - simplex[0])
                    simplex[index] = np.clip(
                        simplex[index],
                        [item[0] for item in bounds],
                        [item[1] for item in bounds],
                    )
                    values[index] = function(simplex[index])

        history.append(
            {
                "iter": iteration,
                "best_f": values[0],
                "best_x": simplex[0].copy(),
            }
        )
        if iteration > 50 and abs(values[0] - values[-1]) < tol:
            break

    return simplex[0], values[0], history


def gen_farm_batches(
    n: int = 10,
    farm_bias: dict | None = None,
    seed: int = 456,
) -> tuple[list[dict], np.ndarray, dict]:
    rng = np.random.default_rng(seed)
    if farm_bias is None:
        farm_bias = {"scaleFactor": 0.95, "peakAdjust": -0.03}
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
        records = []
        for d in range(ea - sa + 1):
            cp = max(0, d * rng.uniform(1.5, 4))
            records.append(
                {
                    "dayAge": sa + d,
                    "totalMilkG": 0,
                    "totalCreepG": int(cp * hc),
                    "headCount": hc,
                    "diarrheaMild": 0,
                    "diarrheaModerate": 0,
                    "diarrheaSevere": 0,
                }
            )
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


def main() -> None:
    print("=" * 60)
    print("奶爸机 — 场区生长微调（仅 scaleFactor / peakAdjust）")
    print("=" * 60)

    smoke = os.environ.get("NBJ_OPTIMIZER_SMOKE") == "1"
    farm_bias = {"scaleFactor": 0.92, "peakAdjust": -0.04}
    batches, theta_true, _ = gen_farm_batches(n=10, farm_bias=farm_bias)
    print(f"\n模拟场区生长偏差: scaleFactor={farm_bias['scaleFactor']}, peakAdjust={farm_bias['peakAdjust']}")
    print(f"数据: {len(batches)} 批")

    default_score = score(KNOB_DEFAULT, batches, PARAM_DEFAULT)
    print(f"\n专家默认得分: {default_score:.2f}")

    bounds = [KNOB_RANGE[name] for name in KNOB_NAMES]
    max_iter = 3 if smoke else 150
    best_knobs, best_score_value, history = nelder_mead(
        lambda knobs: score(knobs, batches, PARAM_DEFAULT),
        KNOB_DEFAULT,
        bounds,
        max_iter=max_iter,
    )
    print(f"\n最终候选得分: {best_score_value:.2f}")
    print(f"\n{'旋钮':>12} {'默认':>8} {'候选':>8} {'真值':>8} {'范围':>16}")
    for index, name in enumerate(KNOB_NAMES):
        low, high = KNOB_RANGE[name]
        print(
            f"{name:>12} {KNOB_DEFAULT[index]:>8.3f} {best_knobs[index]:>8.3f} "
            f"{farm_bias[name]:>8.3f} [{low:.2f},{high:.2f}]"
        )
    print("\n结果仅作为 candidate，不会覆盖默认参数或写入生产模型。")
    print(f"真值 θ={' '.join(f'{v:.3f}' for v in theta_true)}")


if __name__ == "__main__":
    main()
