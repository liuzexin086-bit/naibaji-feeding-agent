"""V3 named-parameter random search and local refinement.

This module is the only supported search path for feeding-parameters-v3.
Legacy seven-parameter vectors are rejected by the contract before they can
reach the model.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Iterable

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from contracts import (
    FIELD_DEFAULTS,
    FIELD_ORDER,
    FIELD_RANGES,
    PARAM_DEFAULT,
    SCHEMA_VERSION,
    FeedingParametersV3,
)
from model import WEIGHT_STANDARD, diff_forward

MODEL_VERSION = "feeding-model+v5-lite@optimizer-v3"


def generate_batches(n_batches: int = 15, seed: int = 123) -> list[dict]:
    rng = np.random.default_rng(seed)
    batches = []
    for _ in range(n_batches):
        sa = int(rng.integers(3, 8))
        ea = int(rng.integers(21, 25))
        hc = int(rng.integers(8, 20))
        sw = round(WEIGHT_STANDARD.get(sa, 2.3) + rng.uniform(-0.2, 0.2), 2)
        td = ea - sa + 1

        records = []
        for d in range(td):
            da = sa + d
            creep_base = max(0, d * rng.uniform(1.5, 4))
            records.append({
                "dayAge": da,
                "totalMilkG": 0,
                "totalCreepG": int(round(creep_base * hc)),
                "headCount": hc,
                "diarrheaMild": 0,
                "diarrheaModerate": 0,
                "diarrheaSevere": 0,
            })
        batches.append({
            "startAge": sa,
            "endAge": ea,
            "startWeight": sw,
            "headCount": hc,
            "records": records,
        })
    return batches


def evaluate(params: FeedingParametersV3, batch: dict) -> tuple[float, float, float]:
    r = diff_forward(params, batch)
    adg = r["adg"]
    diar = r["totalDiarRate"]
    loss = -adg + 15.0 * max(0, diar - 0.05) * 100
    return loss, adg, diar


def evaluate_batches(
    params: FeedingParametersV3,
    batches: Iterable[dict],
) -> tuple[float, float, float]:
    total_loss = 0.0
    total_adg = 0.0
    total_diar = 0.0
    count = 0
    for batch in batches:
        loss, adg, diar = evaluate(params, batch)
        total_loss += loss
        total_adg += adg
        total_diar += diar
        count += 1
    return (
        total_loss / max(count, 1),
        total_adg / max(count, 1),
        total_diar / max(count, 1),
    )


def random_search(
    batches: list[dict],
    n_trials: int = 3000,
    seed: int = 456,
) -> tuple[FeedingParametersV3, float, list[dict]]:
    rng = np.random.default_rng(seed)
    best_params = FeedingParametersV3.defaults()
    best_loss, _, _ = evaluate_batches(best_params, batches)
    results: list[dict] = []

    for _ in range(n_trials):
        values = {
            name: float(rng.uniform(*FIELD_RANGES[name]))
            for name in FIELD_ORDER
        }
        params = FeedingParametersV3.from_mapping(values)
        loss, adg, diar = evaluate_batches(params, batches)
        results.append({
            "parameters": params.to_mapping(),
            "loss": loss,
            "ADG": adg,
            "diarrhea": diar,
        })
        if loss < best_loss:
            best_loss = loss
            best_params = params

    return best_params, best_loss, results


def local_refine(
    batches: list[dict],
    center: FeedingParametersV3,
    n_trials: int = 500,
    radius: float = 0.05,
    seed: int = 789,
) -> tuple[FeedingParametersV3, float, list[dict]]:
    rng = np.random.default_rng(seed)
    best_params = center
    best_loss, _, _ = evaluate_batches(center, batches)
    results: list[dict] = []

    for _ in range(n_trials):
        values = dict(center.to_mapping()["parameters"])
        for name in FIELD_ORDER:
            low, high = FIELD_RANGES[name]
            scale = (high - low) * radius
            candidate = float(values[name]) + float(rng.uniform(-scale, scale))
            values[name] = float(np.clip(candidate, low, high))
        params = FeedingParametersV3.from_mapping(values)
        loss, adg, diar = evaluate_batches(params, batches)
        results.append({
            "parameters": params.to_mapping(),
            "loss": loss,
            "ADG": adg,
            "diarrhea": diar,
        })
        if loss < best_loss:
            best_loss = loss
            best_params = params

    return best_params, best_loss, results


def data_digest(batches: list[dict]) -> str:
    canonical = json.dumps(batches, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def build_search_output(
    batches: list[dict],
    best_params: FeedingParametersV3,
    initial_metrics: tuple[float, float, float],
    optimal_metrics: tuple[float, float, float],
    all_results: list[dict],
    refine_results: list[dict],
    *,
    random_seed: int = 456,
    local_seed: int = 789,
) -> dict:
    loss0, adg0, diar0 = initial_metrics
    loss2, adg2, diar2 = optimal_metrics
    return {
        "schemaVersion": SCHEMA_VERSION,
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "seed": {"randomSearch": random_seed, "localRefine": local_seed},
        "dataSummary": {
            "batchCount": len(batches),
            "dataSha256": data_digest(batches),
        },
        "parameters": best_params.to_mapping(),
        "theta_default": PARAM_DEFAULT.tolist(),
        "theta_opt": best_params.to_vector().tolist(),
        "metrics": {
            "ADG": {"initial": round(adg0, 2), "optimal": round(adg2, 2)},
            "diarrheaRate": {
                "initial": round(diar0, 4),
                "optimal": round(diar2, 4),
            },
            "loss": {"initial": round(loss0, 2), "optimal": round(loss2, 2)},
        },
        "search_results": [
            {
                "parameters": row["parameters"],
                "loss": row["loss"],
                "ADG": row["ADG"],
                "diarrhea": row["diarrhea"],
            }
            for row in sorted(
                all_results + refine_results,
                key=lambda item: item["loss"],
            )[:50]
        ],
    }


def main() -> None:
    print("=" * 60)
    print("奶爸机 V3 — 随机搜索 + 局部精调（feeding-parameters-v3）")
    print("=" * 60)

    smoke = os.environ.get("NBJ_OPTIMIZER_SMOKE") == "1"
    batches = generate_batches(15)
    print(f"\n模拟批次: {len(batches)} 批")

    defaults = FeedingParametersV3.defaults()
    loss0, adg0, diar0 = evaluate_batches(defaults, batches)
    print(f"\n默认参数: ADG={adg0:.1f}g, 腹泻率={diar0*100:.1f}%, 损失={loss0:.2f}")
    print(f"  {defaults.to_mapping()['parameters']}")

    trials = 3 if smoke else 3000
    print(f"\n阶段1: 随机搜索 ({trials}次)...")
    best1, loss1, all_results = random_search(batches, n_trials=trials)
    loss1, adg1, diar1 = evaluate_batches(best1, batches)
    print(f"  最优: ADG={adg1:.1f}g, 腹泻率={diar1*100:.1f}%, 损失={loss1:.2f}")

    refine_trials = 2 if smoke else 500
    print(f"\n阶段2: 局部精调 ({refine_trials}次)...")
    best2, loss2, refine_results = local_refine(batches, best1, n_trials=refine_trials)
    adg2, diar2 = evaluate_batches(best2, batches)[1:]
    print(f"  最优: ADG={adg2:.1f}g, 腹泻率={diar2*100:.1f}%, 损失={loss2:.2f}")

    print("\n参数对比")
    print("-" * 60)
    print(f"{'参数':>22} {'默认':>8} {'最优':>8} {'范围':>20}")
    for name in FIELD_ORDER:
        low, high = FIELD_RANGES[name]
        print(
            f"{name:>22} {FIELD_DEFAULTS[name]:>8.3f} "
            f"{getattr(best2, name):>8.3f} [{low:.2f}, {high:.2f}]"
        )

    output = build_search_output(
        batches,
        best2,
        (loss0, adg0, diar0),
        (loss2, adg2, diar2),
        all_results,
        refine_results,
    )
    if not smoke:
        path = os.path.join(os.path.dirname(__file__), "search_result.json")
        with open(path, "w", encoding="utf-8") as file:
            json.dump(output, file, ensure_ascii=False, indent=2)
        print(f"\n结果已保存到 search_result.json")


if __name__ == "__main__":
    main()
