"""
模拟 + 训练 V3 — 6 参数（FCR 固定，饲喂效率内生）
"""
import numpy as np
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))

from model import diff_forward, WEIGHT_STANDARD, PARAM_NAMES, PARAM_DEFAULT, PARAM_RANGE
from loss import compute_loss
from train import train


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


def main():
    print('=' * 60)
    print('奶爸机 V3 — 6参数 (FCR/教槽当量固定)')
    print('=' * 60)

    batches = gen_batches(15)

    # 显示默认值
    print(f'\n固定参数: FCR={0.90:.2f}  creepEq={0.65:.2f}  baseMeals=12')
    loss0, m0 = compute_loss(PARAM_DEFAULT, batches)
    print(f'默认 ({len(batches)}批): ADG={m0["ADG"]:.1f}g  腹泻率={m0["diarrheaRate"]*100:.1f}%  L={loss0:.2f}')
    print('θ=' + ' '.join(f'{n}={v:.3f}' for n, v in zip(PARAM_NAMES, PARAM_DEFAULT)))

    print(f'\nRMSprop 梯度下降 ...')
    print('-' * 60)

    theta_opt, history = train(PARAM_DEFAULT.copy(), batches, compute_loss,
                                lr=0.5, epochs=200)

    loss_opt, m_opt = compute_loss(theta_opt, batches)

    print('\n' + '=' * 60)
    print('结果')
    print('=' * 60)
    for i, name in enumerate(PARAM_NAMES):
        lo, hi = PARAM_RANGE[name]; v = theta_opt[i]; hit = ''
        if abs(v - lo) < 0.005: hit = ' ← 下界'
        elif abs(v - hi) < 0.005: hit = ' ← 上界'
        print(f'  {name:>10} {PARAM_DEFAULT[i]:.3f} → {v:.3f} [{lo:.2f},{hi:.2f}]{hit}')

    print(f'\n  ADG: {m0["ADG"]:.1f} → {m_opt["ADG"]:.1f} g/天 ({m_opt["ADG"]-m0["ADG"]:+.1f})')
    print(f'  腹泻率: {m0["diarrheaRate"]*100:.1f} → {m_opt["diarrheaRate"]*100:.1f}%')
    print(f'  损失: {loss0:.2f} → {loss_opt:.2f}')

    # 检查一个批次的平均 FCR
    sample = diff_forward(theta_opt, batches[0])
    print(f'  有效FCR范围: {sample["dailyFCR"].min():.3f} ~ {sample["dailyFCR"].max():.3f}')

    # 保存
    out = {'theta_names': PARAM_NAMES, 'theta_default': PARAM_DEFAULT.tolist(),
           'theta_opt': theta_opt.tolist(),
           'adg': {'init': round(m0['ADG'],1), 'opt': round(m_opt['ADG'],1)},
           'diarrheaRate': {'init': round(m0['diarrheaRate'],4), 'opt': round(m_opt['diarrheaRate'],4)},
           'loss': {'init': round(loss0,2), 'opt': round(loss_opt,2)},
           'history': [{'epoch':h['epoch'],'loss':h['loss'],'ADG':h['ADG'],
                        'diarrheaRate':h['diarrheaRate'],'theta':h['theta'].tolist()}
                       for h in history]}
    p = os.path.join(os.path.dirname(__file__), 'simulation_v3.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f'\n已保存 simulation_v3.json')


if __name__ == '__main__':
    main()
