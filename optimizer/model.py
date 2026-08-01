"""
奶爸机 — 可微前向传播 V3
==========================
核心改进:
1. FCR 依赖饲喂水平（喂少了 FCR 变差，饥饿时维持占比更大）
2. 教槽当量自然饱和（高教槽时边际效益递减）
3. 稀释比影响消化效率（太稀了 FCR 变差）
4. 只有 6 个可调参数
"""

import numpy as np

STOMACH_ML_PER_KG = 30
SAFETY_FACTOR = 0.85

WEIGHT_STANDARD = {
    3: 2.3, 4: 2.4, 5: 2.6, 6: 2.8, 7: 3.0,
    8: 3.2, 9: 3.4, 10: 3.6, 11: 3.8, 12: 4.0, 13: 4.2, 14: 4.4,
    15: 4.6, 16: 4.8, 17: 5.0, 18: 5.2, 19: 5.4, 20: 5.6, 21: 5.8,
}

PARAM_NAMES = ['baseLevel', 'ramp', 'peakLevel', 'threshold', 'dilution', 'diarSense']
# FCR 和 creepEq 不优化（固定值），baseMeals 固定 12

PARAM_RANGE = {
    'baseLevel': (0.18, 0.40),
    'ramp':      (0.15, 0.50),
    'peakLevel': (0.68, 0.92),
    'threshold': (150, 220),
    'dilution':  (5, 8),
    'diarSense': (0.3, 2.0),
}

PARAM_DEFAULT = np.array([0.28, 0.40, 0.82, 180, 6, 1.0])

FCR_BASE = 0.90
CREEP_EQ = 0.65
BASE_MEALS = 12


def softplus(x):
    return np.where(x > 20, x, np.log1p(np.exp(x)))

def sigmoid(x):
    return 1 / (1 + np.exp(-np.clip(x, -20, 20)))


# ---------- 单调递增曲线 ----------

def compute_ratios(base_level, ramp, peak_level, n_days):
    ratios = np.zeros(n_days)
    ratios[0] = base_level
    if n_days > 1:
        for d in range(1, min(4, n_days)):
            ratios[d] = base_level + ramp * (d / 3) * 0.7
    for d in range(4, n_days):
        ratios[d] = peak_level
    return np.clip(ratios, 0.10, 0.95)


# ---------- 有效 FCR（依赖饲喂水平）----------

def effective_fcr(milk_ratio, base_fcr, dilution):
    """
    饲喂效率惩罚：
    - milk_ratio=0.85（最优水平）: 无惩罚
    - milk_ratio=0.40（严重低喂）: +15% FCR（维持需要占比大）
    - milk_ratio=1.20（严重过喂）: +8% FCR（消化负担）
    - 稀释比高(1:7)时额外 +3~5% FCR
    """
    under_penalty = 0.25 * max(0, 0.85 - milk_ratio) ** 2
    over_penalty = 0.10 * max(0, milk_ratio - 0.85) ** 2
    dilu_penalty = 0.03 * max(0, dilution - 6)

    penalty = under_penalty + over_penalty + dilu_penalty
    return base_fcr * (1 + penalty)


# ---------- 腹泻率（宽松阈值，平滑上升）----------

def estimate_diarrhea(milk_ratio, creep_pp, sensitivity):
    excess = np.maximum(0, milk_ratio - 0.35)
    base = 0.01 + 0.65 * (1 - np.exp(-3 * excess))
    creep_factor = 1 - 0.2 * sigmoid(creep_pp / 30)
    return np.clip(base * creep_factor * sensitivity, 0.002, 0.95)


# ---------- 主前向 ----------

def diff_forward(theta, batch):
    base_level = theta[0]
    ramp = theta[1]
    peak_level = theta[2]
    threshold = theta[3]
    dilution = max(theta[4], 4)
    diar_sense = max(theta[5], 0.1)

    sa = batch['startAge']
    ea = batch['endAge']
    sw = batch['startWeight'] if batch['startWeight'] > 0 else WEIGHT_STANDARD.get(sa, 2.3)
    hc = batch['headCount']
    records = batch.get('records', [])
    td = ea - sa + 1
    ratios = compute_ratios(base_level, ramp, peak_level, td)

    creep_map = {}
    for r in records:
        if r.get('totalCreepG') is not None and r.get('headCount', 0) > 0:
            creep_map[r['dayAge']] = r['totalCreepG'] / r['headCount']
    creep_hist = list(creep_map.values())

    weight = sw
    daily_milk = []
    daily_gain = []
    daily_weight = [weight]
    daily_diar_rate = []
    daily_fcr = []

    for d in range(td):
        da = sa + d
        raw_daily = weight * STOMACH_ML_PER_KG * SAFETY_FACTOR * BASE_MEALS / dilution
        ratio = ratios[min(d, td - 1)]
        milk_pp = raw_daily * ratio
        milk_ratio = milk_pp / (weight * STOMACH_ML_PER_KG * BASE_MEALS / dilution + 1e-12)

        # 控奶
        if creep_hist:
            ca = creep_hist[-1]
            sc = np.clip(12 - ca / 70 * 4, 2, BASE_MEALS)
            cm = max(sc * 0.9, 2)
            pfc = raw_daily / BASE_MEALS
            adj = pfc * cm
            pg = (adj + ca * CREEP_EQ) / FCR_BASE
            go = sigmoid((pg - threshold) / 10)
            milk_pp = (1 - go) * adj + go * milk_pp
            milk_ratio = milk_pp / (weight * STOMACH_ML_PER_KG * BASE_MEALS / dilution + 1e-12)

        fcr_eff = effective_fcr(milk_ratio, FCR_BASE, dilution)
        gain = milk_pp / (fcr_eff * 1000)
        weight += gain

        cp = creep_map.get(da, creep_hist[-1] if creep_hist else 0)
        dr = estimate_diarrhea(milk_ratio, cp, diar_sense)

        daily_milk.append(milk_pp)
        daily_gain.append(gain * 1000)
        daily_weight.append(weight)
        daily_diar_rate.append(dr)
        daily_fcr.append(fcr_eff)

    fw = weight
    adg = (fw - sw) / td * 1000
    tdr = np.mean(daily_diar_rate)

    return {
        'dailyMilk': np.array(daily_milk),
        'dailyGain': np.array(daily_gain),
        'dailyWeight': np.array(daily_weight),
        'dailyDiarRate': np.array(daily_diar_rate),
        'dailyFCR': np.array(daily_fcr),
        'dailyRatios': ratios,
        'finalWeight': fw,
        'totalDiarRate': tdr,
        'adg': adg,
    }
