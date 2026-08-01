"""
随机搜索 + 局部精调优化器
=========================
替代梯度下降。直接在原始（不可微）模型上搜索，无近似。

阶段1: 粗粒度随机搜索（3000次）
阶段2: 最优解附近局部精调（500次）

用法:
  conda run -n base python search.py
  或 E:\miniconda3\python.exe search.py
"""

import numpy as np
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from model import diff_forward, WEIGHT_STANDARD

# ---------- 参数空间 ----------
PARAM_NAMES = ['D1', 'D2', 'D3', 'D4+', 'FCR', 'CreepEq', 'Threshold']

# 合理的参数范围（不推到极限）
PARAM_RANGE = {
    'D1':       (0.20, 0.40),
    'D2':       (0.45, 0.70),
    'D3':       (0.65, 0.85),
    'D4+':      (0.75, 0.90),
    'FCR':      (0.85, 0.95),
    'CreepEq':  (0.55, 0.75),
    'Threshold': (160, 210),
}

DEFAULT = np.array([0.30, 0.60, 0.78, 0.85, 0.90, 0.70, 180])

# ---------- 模拟数据 ----------
def generate_batches(n_batches=15, seed=123):
    rng = np.random.default_rng(seed)
    batches = []
    for _ in range(n_batches):
        sa = int(rng.integers(3, 8))
        ea = int(rng.integers(21, 25))
        hc = int(rng.integers(8, 20))
        sw = round(WEIGHT_STANDARD.get(sa, 2.3) + rng.uniform(-0.2, 0.2), 2)
        td = ea - sa + 1

        # 有噪声的教槽数据
        records = []
        for d in range(td):
            da = sa + d
            creep_base = max(0, d * rng.uniform(1.5, 4))
            records.append({
                'dayAge': da,
                'totalMilkG': 0,
                'totalCreepG': int(round(creep_base * hc)),
                'headCount': hc,
                'diarrheaMild': 0,
                'diarrheaModerate': 0,
                'diarrheaSevere': 0,
            })
        batches.append({
            'startAge': sa, 'endAge': ea, 'startWeight': sw,
            'headCount': hc, 'records': records,
        })
    return batches


# ---------- 损失函数（直接用原始前向，取整也不怕） ----------
def evaluate(theta, batch):
    r = diff_forward(theta, batch)
    adg = r['adg']
    diar = r['totalDiarRate']

    # L = -ADG + 15 * max(0, diar - 0.05) * 100
    loss = -adg + 15.0 * max(0, diar - 0.05) * 100
    return loss, adg, diar


def evaluate_batches(theta, batches):
    total_loss = 0
    total_adg = 0
    total_diar = 0
    n = len(batches)
    for b in batches:
        l, adg, diar = evaluate(theta, b)
        total_loss += l
        total_adg += adg
        total_diar += diar
    return total_loss / n, total_adg / n, total_diar / n


# ---------- 阶段1: 随机搜索 ----------
def random_search(batches, n_trials=3000, seed=456):
    rng = np.random.default_rng(seed)
    best_theta = None
    best_loss = float('inf')
    results = []

    for i in range(n_trials):
        theta = np.array([
            rng.uniform(*PARAM_RANGE['D1']),
            rng.uniform(*PARAM_RANGE['D2']),
            rng.uniform(*PARAM_RANGE['D3']),
            rng.uniform(*PARAM_RANGE['D4+']),
            rng.uniform(*PARAM_RANGE['FCR']),
            rng.uniform(*PARAM_RANGE['CreepEq']),
            rng.uniform(*PARAM_RANGE['Threshold']),
        ])
        loss, adg, diar = evaluate_batches(batches, theta)
        results.append({'theta': theta.copy(), 'loss': loss, 'ADG': adg, 'diarrhea': diar})
        if loss < best_loss:
            best_loss = loss
            best_theta = theta.copy()

    return best_theta, best_loss, results


# ---------- 阶段2: 局部精调 ----------
def local_refine(batches, center, n_trials=500, radius=0.05, seed=789):
    rng = np.random.default_rng(seed)
    best_theta = center.copy()
    best_loss, _, _ = evaluate_batches(batches, center)
    results = []

    for i in range(n_trials):
        theta = center.copy()
        for j in range(7):
            lo, hi = PARAM_RANGE[PARAM_NAMES[j]]
            scale = (hi - lo) * radius
            theta[j] += rng.uniform(-scale, scale)
            theta[j] = np.clip(theta[j], lo, hi)

        loss, adg, diar = evaluate_batches(batches, theta)
        results.append({'theta': theta.copy(), 'loss': loss, 'ADG': adg, 'diarrhea': diar})
        if loss < best_loss:
            best_loss = loss
            best_theta = theta.copy()

    return best_theta, best_loss, results


# ---------- 主流程 ----------
def main():
    print('=' * 60)
    print('奶爸机 — 随机搜索 + 局部精调')
    print('=' * 60)

    batches = generate_batches(15)
    print(f'\n模拟批次: {len(batches)} 批')

    # 默认参数评估
    loss0, adg0, diar0 = evaluate_batches(batches, DEFAULT)
    print(f'\n默认参数: ADG={adg0:.1f}g, 腹泻率={diar0*100:.1f}%, 损失={loss0:.2f}')
    print(f'  {" ".join(f"{n}={v:.3f}" for n, v in zip(PARAM_NAMES, DEFAULT))}')

    # ---- 阶段1 ----
    print(f'\n阶段1: 随机搜索 (3000次)...')
    best1, loss1, all_results = random_search(batches, n_trials=3000)
    adg1, diar1 = all_results[0]['ADG'], all_results[0]['diarrhea']

    # 重新评估最佳结果
    loss1, adg1, diar1 = evaluate_batches(batches, best1)
    print(f'  最优: ADG={adg1:.1f}g, 腹泻率={diar1*100:.1f}%, 损失={loss1:.2f}')
    print(f'  θ=[{" ".join(f"{v:.3f}" for v in best1)}]')

    # ---- 阶段2 ----
    print(f'\n阶段2: 局部精调 (500次)...')
    best2, loss2, refine_results = local_refine(batches, best1, n_trials=500)
    adg2, diar2 = evaluate_batches(batches, best2)[1:]
    print(f'  最优: ADG={adg2:.1f}g, 腹泻率={diar2*100:.1f}%, 损失={loss2:.2f}')
    print(f'  θ=[{" ".join(f"{v:.3f}" for v in best2)}]')

    # ---- 输出对比 ----
    print('\n' + '-' * 60)
    print('参数对比')
    print('-' * 60)
    print(f'{"参数":>8} {"默认":>8} {"最优":>8} {"范围":>16}')
    for i, name in enumerate(PARAM_NAMES):
        lo, hi = PARAM_RANGE[name]
        print(f'{name:>8} {DEFAULT[i]:>8.3f} {best2[i]:>8.3f} [{lo:.2f}, {hi:.2f}]')

    print('\n' + '-' * 60)
    print('指标对比')
    print('-' * 60)
    print(f'  ADG:     {adg0:.1f} → {adg2:.1f} g/天 ({adg2-adg0:+.1f})')
    print(f'  腹泻率:  {diar0*100:.1f} → {diar2*100:.1f}% ({(diar2-diar0)*100:+.1f})')
    print(f'  损失:    {loss0:.2f} → {loss2:.2f} ({loss2-loss0:+.2f})')

    # 检查是否触碰边界
    print('\n边界检查:')
    for i, name in enumerate(PARAM_NAMES):
        lo, hi = PARAM_RANGE[name]
        val = best2[i]
        at_bound = ''
        if abs(val - lo) < 0.005:
            at_bound = ' ← 下界'
        elif abs(val - hi) < 0.005:
            at_bound = ' ← 上界'
        print(f'  {name}: {val:.3f} [{lo:.2f}, {hi:.2f}]{at_bound}')

    # ---- 保存结果 ----
    output = {
        'theta_names': PARAM_NAMES,
        'theta_default': DEFAULT.tolist(),
        'theta_opt': best2.tolist(),
        'adg': {'initial': round(adg0, 2), 'optimal': round(adg2, 2)},
        'diarrheaRate': {'initial': round(diar0, 4), 'optimal': round(diar2, 4)},
        'loss': {'initial': round(loss0, 2), 'optimal': round(loss2, 2)},
        'search_results': [{
            'loss': r['loss'], 'ADG': r['ADG'], 'diarrhea': r['diarrhea'],
            'theta': r['theta'].tolist(),
        } for r in sorted(all_results + refine_results, key=lambda x: x['loss'])[:50]],
    }
    path = os.path.join(os.path.dirname(__file__), 'search_result.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'\n结果已保存到 search_result.json')


if __name__ == '__main__':
    main()
