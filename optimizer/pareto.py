"""
帕累托前沿搜索
==============
不做梯度下降，不调损失权重。直接在真实模型上随机采样，绘制 ADG vs 腹泻率的 Pareto 前沿。

饲养员或算法从 Pareto 前沿上选一个点：
  - 保守：腹泻率 5% → 可接受
  - 激进：腹泻率 10% → ADG 更高
"""

import numpy as np
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))

from contracts import PARAM_DEFAULT, PARAM_NAMES, PARAM_RANGE
from model import BASE_MEALS, CREEP_EQ, FCR_BASE, WEIGHT_STANDARD, diff_forward


def gen_batches(n=15, seed=123):
    rng = np.random.default_rng(seed)
    batches = []
    for _ in range(n):
        sa = int(rng.integers(3, 8))
        ea = int(rng.integers(21, 25))
        hc = int(rng.integers(8, 20))
        sw = round(WEIGHT_STANDARD.get(sa, 2.3) + rng.uniform(-0.2, 0.2), 2)
        recs = []
        for d in range(ea - sa + 1):
            cp = max(0, d * rng.uniform(1.5, 4))
            recs.append({'dayAge': sa + d, 'totalMilkG': 0,
                         'totalCreepG': int(cp * hc), 'headCount': hc,
                         'diarrheaMild': 0, 'diarrheaModerate': 0, 'diarrheaSevere': 0})
        batches.append({'startAge': sa, 'endAge': ea, 'startWeight': sw,
                        'headCount': hc, 'records': recs})
    return batches


def evaluate(theta, batches):
    adg_acc = 0; diar_acc = 0
    for b in batches:
        r = diff_forward(theta, b)
        adg_acc += r['adg']; diar_acc += r['totalDiarRate']
    return adg_acc / len(batches), diar_acc / len(batches)


def pareto_frontier(points):
    """
    计算 Pareto 前沿（最大化 ADG，最小化腹泻率）
    """
    points = sorted(points, key=lambda p: -p[0])  # 按 ADG 降序
    front = []
    min_diar = float('inf')
    for adg, diar, theta in points:
        if diar < min_diar:
            min_diar = diar
            front.append((adg, diar, theta))
    return front


def main():
    print('=' * 60)
    print('奶爸机 — Pareto 前沿搜索')
    print('=' * 60)
    print(f'  固定: FCR={FCR_BASE}  creepEq={CREEP_EQ}  baseMeals={BASE_MEALS}')

    batches = gen_batches(15)

    # 默认值
    adg0, diar0 = evaluate(PARAM_DEFAULT, batches)
    print(f'\n默认参数: ADG={adg0:.1f}g  腹泻率={diar0*100:.1f}%')
    print(f'  θ={" ".join(f"{n}={v:.3f}" for n,v in zip(PARAM_NAMES, PARAM_DEFAULT))}')
    print(f'\n随机搜索 Pareto 前沿 (2万次)...')

    rng = np.random.default_rng(456)
    all_points = [(adg0, diar0, PARAM_DEFAULT.copy())]

    for i in range(20000):
        theta = np.array([rng.uniform(*PARAM_RANGE[n]) for n in PARAM_NAMES])
        adg, diar = evaluate(theta, batches)
        all_points.append((adg, diar, theta))

    front = pareto_frontier(all_points)

    print(f'\nPareto 前沿 ({len(front)} 个非支配解):')
    print(f'  {"ADG(g/天)":>10} {"腹泻率%":>8} {"baseLevel":>9} {"ramp":>9} {"peakLevel":>9} {"thresh":>9} {"dilu":>9} {"sense":>9}')
    print(f'  {"-"*10} {"-"*8} {"-"*9} {"-"*9} {"-"*9} {"-"*9} {"-"*9} {"-"*9}')

    for adg, diar, theta in front:
        print(f'  {adg:>8.1f}  {diar*100:>7.2f}  {theta[0]:>8.3f}  {theta[1]:>8.3f}  {theta[2]:>8.3f}  {theta[3]:>8.0f}  {theta[4]:>8.1f}  {theta[5]:>8.2f}')

    # Pareto 上的推荐点
    print(f'\n推荐方案:')
    targets = [0.05, 0.08, 0.10, 0.15]  # 腹泻率目标
    for t in targets:
        candidates = [(adg, diar, th) for adg, diar, th in front if diar <= t]
        if candidates:
            best = max(candidates, key=lambda x: x[0])
            print(f'  腹泻率≤{t*100:.0f}% → ADG={best[0]:.1f}g, θ={" ".join(f"{v:.3f}" for v in best[2])}')

    # 保存
    out = {
        'theta_names': PARAM_NAMES,
        'theta_default': PARAM_DEFAULT.tolist(),
        'theta_range': {n: PARAM_RANGE[n] for n in PARAM_NAMES},
        'default': {'ADG': round(adg0, 1), 'diarrheaRate': round(diar0, 4)},
        'pareto_front': [{'ADG': round(adg, 1), 'diarrheaRate': round(diar, 4),
                          'theta': th.tolist()} for adg, diar, th in front],
    }
    p = os.path.join(os.path.dirname(__file__), 'pareto_result.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f'\n已保存 pareto_result.json')


if __name__ == '__main__':
    main()
