"""
场区偏移量校准器
================
用该场区已完成的批次数据，校准 3 个偏移量。
目标：让模型预测的 ADG 最接近该场实测 ADG。
不需要调损失权重，不需要对抗腹泻指标——直接从数据里学。

用法: conda run -n base python calibrate.py
"""

import numpy as np
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))

from model import diff_forward, WEIGHT_STANDARD, PARAM_NAMES, PARAM_DEFAULT
from model import FCR_BASE, CREEP_EQ, BASE_MEALS

KNOB_NAMES = ['scaleFactor', 'peakAdjust', 'diarOffset']
KNOB_RANGE = {'scaleFactor': (0.90, 1.10), 'peakAdjust': (-0.05, 0.05), 'diarOffset': (-0.5, 0.5)}
KNOB_DEFAULT = np.array([1.0, 0.0, 0.0])


def apply_knobs(theta_base, knobs):
    """场区偏移量 → 调整后参数"""
    theta = theta_base.copy()
    theta[0] *= knobs[0]
    theta[1] *= knobs[0]
    theta[2] = np.clip(theta[2] + knobs[1], 0.62, 0.93)
    theta[5] = np.clip(theta[5] + knobs[2], 0.15, 2.2)
    return theta


def predict_error(knobs, batches, theta_base):
    """
    预测误差 = Σ(预测ADG - 实测ADG)²
    只需要 weighSample 中记录了真实体重。
    """
    err = 0
    for b in batches:
        theta = apply_knobs(theta_base, knobs)
        r = diff_forward(theta, b)
        pred_adg = r['adg']

        # 从 records 中的 weighSample 推算实测 ADG
        records = b.get('records', [])
        measured_weights = []
        for rec in records:
            if rec.get('weighSample') and len(rec['weighSample']) > 0:
                ws = rec['weighSample']
                total_w = sum(w['avgKg'] * w['headCount'] for w in ws)
                total_n = sum(w['headCount'] for w in ws)
                if total_n > 0:
                    measured_weights.append((rec['dayAge'], total_w / total_n))

        if len(measured_weights) >= 2:
            w0 = measured_weights[0]
            w1 = measured_weights[-1]
            days = w1[0] - w0[0]
            if days > 0:
                actual_adg = (w1[1] - w0[1]) / days * 1000
                err += (pred_adg - actual_adg) ** 2

    return err / max(len(batches), 1)


# ---------- 模拟一个"有真实称重数据的场区" ----------

def gen_farm_with_weights(n=8, farm_bias=None, seed=789):
    """生成带称重数据的模拟场区"""
    rng = np.random.default_rng(seed)
    if farm_bias is None:
        farm_bias = {'scaleFactor': 0.95, 'peakAdjust': -0.02, 'diarOffset': 0.2}
    theta_true = apply_knobs(PARAM_DEFAULT, np.array([farm_bias['scaleFactor'], farm_bias['peakAdjust'], farm_bias['diarOffset']]))

    batches = []
    for _ in range(n):
        sa = int(rng.integers(3, 8))
        ea = int(rng.integers(21, 25))
        hc = int(rng.integers(8, 20))
        sw = round(WEIGHT_STANDARD.get(sa, 2.3) + rng.uniform(-0.2, 0.2), 2)

        # 用真值参数生成"真实"数据
        dummy_batch = {'startAge': sa, 'endAge': ea, 'startWeight': sw,
                       'headCount': hc, 'records': []}
        for d in range(ea - sa + 1):
            cp = max(0, d * rng.uniform(1.5, 4))
            dummy_batch['records'].append(
                {'dayAge': sa + d, 'totalCreepG': int(cp * hc), 'headCount': hc})

        true_r = diff_forward(theta_true, dummy_batch)

        # 构建带称重 records
        recs = []
        weigh_days = [0, (ea - sa) // 2, ea - sa]  # D1, 中点, 终点称重
        for d in range(ea - sa + 1):
            day_age = sa + d
            cp = max(0, d * rng.uniform(1.5, 4))
            rec = {'dayAge': day_age,
                   'totalMilkG': int(true_r['dailyMilk'][d] * hc * (1 + rng.normal(0, 0.03))),
                   'totalCreepG': int(cp * hc),
                   'headCount': hc,
                   'diarrheaMild': 0, 'diarrheaModerate': 0, 'diarrheaSevere': 0}

            if d in weigh_days:
                true_w = true_r['dailyWeight'][d]
                rec['weighSample'] = [
                    {'category': 'large', 'avgKg': round(true_w * rng.uniform(1.05, 1.15), 2), 'headCount': hc // 3},
                    {'category': 'medium', 'avgKg': round(true_w * rng.uniform(0.95, 1.05), 2), 'headCount': hc // 3},
                    {'category': 'small', 'avgKg': round(true_w * rng.uniform(0.85, 0.95), 2), 'headCount': hc - 2 * (hc // 3)},
                ]
            recs.append(rec)

        batches.append({'startAge': sa, 'endAge': ea, 'startWeight': sw,
                        'headCount': hc, 'records': recs})

    return batches, theta_true, farm_bias


# ---------- 网格搜索 ----------

def grid_search(batches, theta_base):
    """3 个旋钮，每维 11 格，共 1331 次评估"""
    best_k = KNOB_DEFAULT.copy()
    best_err = float('inf')

    for sf in np.linspace(*KNOB_RANGE['scaleFactor'], 11):
        for pa in np.linspace(*KNOB_RANGE['peakAdjust'], 11):
            for do in np.linspace(*KNOB_RANGE['diarOffset'], 11):
                k = np.array([sf, pa, do])
                err = predict_error(k, batches, theta_base)
                if err < best_err:
                    best_err = err
                    best_k = k.copy()
    return best_k, best_err


# ---------- 主流程 ----------

def main():
    print('=' * 60)
    print('奶爸机 — 场区偏移量校准')
    print('=' * 60)

    farm_bias = {'scaleFactor': 0.95, 'peakAdjust': -0.02, 'diarOffset': 0.20}
    batches, theta_true, _ = gen_farm_with_weights(n=8, farm_bias=farm_bias)

    print(f'\n场区真实偏差:')
    print(f'  scaleFactor={farm_bias["scaleFactor"]}, peakAdjust={farm_bias["peakAdjust"]}, diarOffset={farm_bias["diarOffset"]}')
    print(f'  真实最优曲线参数: {" ".join(f"{v:.3f}" for v in theta_true)}')
    print(f'  数据: {len(batches)} 批, 每批 {[b["endAge"]-b["startAge"]+1 for b in batches[:3]]}...天, 各 3 次称重')

    # 默认预测误差
    err_default = predict_error(KNOB_DEFAULT, batches, PARAM_DEFAULT)
    print(f'\n默认参数预测误差: {err_default:.4f}')

    # 网格搜索
    print(f'\n网格搜索 11×11×11 = 1331 次评估...')
    best_k, best_err = grid_search(batches, PARAM_DEFAULT)
    theta_opt = apply_knobs(PARAM_DEFAULT, best_k)

    improvement = (err_default - best_err) / err_default * 100
    print(f'\n最优校准: 误差 {err_default:.4f} → {best_err:.4f} ({improvement:.0f}% 降低)')

    print(f'\n{"旋钮":>12} {"默认":>8} {"校准值":>8} {"真值":>8} {"偏差":>8}')
    for i, name in enumerate(KNOB_NAMES):
        true_v = [farm_bias['scaleFactor'], farm_bias['peakAdjust'], farm_bias['diarOffset']][i]
        print(f'{name:>12} {KNOB_DEFAULT[i]:>8.3f} {best_k[i]:>8.3f} {true_v:>8.3f} {best_k[i]-true_v:>+8.3f}')

    print(f'\n校准后曲线参数: {" ".join(f"{v:.3f}" for v in theta_opt)}')

    # 对比效果
    r_def = diff_forward(PARAM_DEFAULT, batches[0])
    r_opt = diff_forward(theta_opt, batches[0])
    print(f'\n指标对比（第 1 批）:')
    print(f'  ADG:     {r_def["adg"]:.1f} → {r_opt["adg"]:.1f} g/天 (目标 ≈ {diff_forward(theta_true, batches[0])["adg"]:.1f})')
    print(f'  腹泻率:  {r_def["totalDiarRate"]*100:.1f} → {r_opt["totalDiarRate"]*100:.1f}%')


if __name__ == '__main__':
    main()
