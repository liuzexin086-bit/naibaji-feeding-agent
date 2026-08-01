"""
场区微调优化器
==============
专家曲线固定，每个场区学 3 个偏移量（±10%）。
用 Nelder-Mead 单纯形搜索，5-10 批数据即可收敛。
"""

import numpy as np
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))

from model import diff_forward, WEIGHT_STANDARD, PARAM_NAMES, PARAM_DEFAULT, PARAM_RANGE
from model import FCR_BASE, CREEP_EQ, BASE_MEALS


KNOB_NAMES = ['scaleFactor', 'peakAdjust', 'diarOffset']
KNOB_RANGE = {'scaleFactor': (0.88, 1.12), 'peakAdjust': (-0.06, 0.06), 'diarOffset': (-0.6, 0.6)}
KNOB_DEFAULT = np.array([1.0, 0.0, 0.0])


def apply_knobs(theta_base, knobs):
    """将场区偏移量应用到基础参数"""
    theta = theta_base.copy()
    theta[0] = theta[0] * knobs[0]            # baseLevel
    theta[1] = theta[1] * knobs[0]            # ramp
    theta[2] = np.clip(theta[2] + knobs[1], 0.60, 0.95)  # peakLevel + offset
    # dilution 和 diarSense 不调或微调
    theta[5] = np.clip(theta[5] + knobs[2], 0.1, 2.5)    # diarSense + offset
    theta[3] = theta[3]                       # threshold 不变
    theta[4] = theta[4]                       # dilution 不变
    return theta


def score(knobs, batches, theta_base):
    """目标函数：返回 -(ADG - 15*max(0,腹泻-0.05)*100)"""
    theta = apply_knobs(theta_base, knobs)
    adg_acc = 0; diar_acc = 0
    for b in batches:
        r = diff_forward(theta, b)
        adg_acc += r['adg']
        diar_acc += r['totalDiarRate']
    adg = adg_acc / len(batches)
    diar = diar_acc / len(batches)
    return -(adg - 15 * max(0, diar - 0.05) * 100)  # 越小越好


# ---------- Nelder-Mead 单纯形 ----------

def nelder_mead(f, x0, bounds, max_iter=200, tol=1e-6, alpha=1.0, gamma=2.0, rho=0.5, sigma=0.5):
    n = len(x0)
    # 初始化单纯形
    simplex = [x0.copy()]
    for i in range(n):
        x = x0.copy()
        x[i] = np.clip(x[i] * 1.05, bounds[i][0], bounds[i][1])
        if x[i] == x0[i]:
            x[i] = np.clip(x0[i] + 0.01, bounds[i][0], bounds[i][1])
        simplex.append(x)

    values = [f(x) for x in simplex]
    history = []

    for it in range(max_iter):
        # 排序
        idx = np.argsort(values)
        simplex = [simplex[i] for i in idx]
        values = [values[i] for i in idx]

        centroid = np.mean(simplex[:-1], axis=0)

        # 反射
        xr = centroid + alpha * (centroid - simplex[-1])
        xr = np.clip(xr, [b[0] for b in bounds], [b[1] for b in bounds])
        vr = f(xr)

        if vr < values[0]:
            xe = centroid + gamma * (xr - centroid)
            xe = np.clip(xe, [b[0] for b in bounds], [b[1] for b in bounds])
            ve = f(xe)
            if ve < vr:
                simplex[-1] = xe; values[-1] = ve
            else:
                simplex[-1] = xr; values[-1] = vr
        elif vr < values[-2]:
            simplex[-1] = xr; values[-1] = vr
        else:
            xc = centroid + rho * (simplex[-1] - centroid)
            xc = np.clip(xc, [b[0] for b in bounds], [b[1] for b in bounds])
            vc = f(xc)
            if vc < values[-1]:
                simplex[-1] = xc; values[-1] = vc
            else:
                for i in range(1, n + 1):
                    simplex[i] = simplex[0] + sigma * (simplex[i] - simplex[0])
                    simplex[i] = np.clip(simplex[i], [b[0] for b in bounds], [b[1] for b in bounds])
                    values[i] = f(simplex[i])

        history.append({
            'iter': it, 'best_f': values[0],
            'best_x': simplex[0].copy(),
            'all_x': [s.copy() for s in simplex],
        })

        if it > 50 and abs(values[0] - values[-1]) < tol:
            break

    return simplex[0], values[0], history


# ---------- 模拟 ----------

def gen_farm_batches(n=10, farm_bias=None, seed=456):
    """生成带场区偏差的模拟数据"""
    rng = np.random.default_rng(seed)
    if farm_bias is None:
        farm_bias = {'scaleFactor': 0.95, 'peakAdjust': -0.03, 'diarOffset': 0.3}
    theta_true = apply_knobs(PARAM_DEFAULT, np.array([farm_bias['scaleFactor'], farm_bias['peakAdjust'], farm_bias['diarOffset']]))

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
    return batches, theta_true, farm_bias


def main():
    print('=' * 60)
    print('奶爸机 — 场区微调优化器')
    print('=' * 60)

    # 模拟一个带偏置的农场（全场平均比专家曲线多 5% 腹泻）
    farm_bias = {'scaleFactor': 0.92, 'peakAdjust': -0.04, 'diarOffset': 0.35}
    batches, theta_true, _ = gen_farm_batches(n=10, farm_bias=farm_bias)
    print(f'\n模拟场区偏置: scaleFactor={farm_bias["scaleFactor"]}, peakAdjust={farm_bias["peakAdjust"]}, diarOffset={farm_bias["diarOffset"]}')
    print(f'真实最优 θ={ " ".join(f"{v:.3f}" for v in theta_true) }')
    print(f'数据: {len(batches)} 批')

    # 初始得分
    f_default = score(KNOB_DEFAULT, batches, PARAM_DEFAULT)
    _, adg_d, diar_d = -f_default, 0, 0
    r = diff_forward(PARAM_DEFAULT, batches[0])
    print(f'\n专家默认: ADG={r["adg"]:.1f}g 腹泻率={r["totalDiarRate"]*100:.1f}%')

    # Nelder-Mead 优化
    bounds = [KNOB_RANGE[n] for n in KNOB_NAMES]
    print(f'\nNelder-Mead 搜索 ({len(batches)}批)...')
    print('-' * 60)

    best_x, best_f, history = nelder_mead(
        lambda k: score(k, batches, PARAM_DEFAULT),
        KNOB_DEFAULT, bounds, max_iter=150
    )

    for h in history[::20]:
        print(f'  迭代{h["iter"]:3d}: 得分={h["best_f"]:.2f}  knobs={" ".join(f"{v:.4f}" for v in h["best_x"])}')

    print(f'\n最终: 得分={best_f:.2f}')
    theta_opt = apply_knobs(PARAM_DEFAULT, best_x)

    print(f'\n{"旋钮":>12} {"默认":>8} {"最优":>8} {"真值":>8} {"范围":>16}')
    for i, name in enumerate(KNOB_NAMES):
        lo, hi = KNOB_RANGE[name]
        print(f'{name:>12} {KNOB_DEFAULT[i]:>8.3f} {best_x[i]:>8.3f} {[farm_bias["scaleFactor"],farm_bias["peakAdjust"],farm_bias["diarOffset"]][i]:>8.3f} [{lo:.2f},{hi:.2f}]')

    # 效果对比
    r_opt = diff_forward(theta_opt, batches[0])
    r_def = diff_forward(PARAM_DEFAULT, batches[0])
    print(f'\n指标对比:')
    print(f'  ADG:     {r_def["adg"]:.1f} → {r_opt["adg"]:.1f} g/天 ({r_opt["adg"]-r_def["adg"]:+.1f})')
    print(f'  腹泻率:  {r_def["totalDiarRate"]*100:.1f} → {r_opt["totalDiarRate"]*100:.1f}%')
    print(f'  有效FCR: {r_def["dailyFCR"].mean():.3f} → {r_opt["dailyFCR"].mean():.3f}')


if __name__ == '__main__':
    main()
