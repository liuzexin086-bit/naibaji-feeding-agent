"""
损失函数 V3 — 6 参数
"""
import numpy as np
from contracts import PARAM_DEFAULT, PARAM_NAMES
from model import FCR_BASE, diff_forward


def compute_loss(theta, batches):
    total = 0
    adg_acc = 0
    diar_acc = 0
    for b in batches:
        r = diff_forward(theta, b)
        adg = r['adg']; diar = r['totalDiarRate']
        loss = -adg + 15 * max(0, diar - 0.05) * 100
        loss += 3 * np.log1p(np.exp(adg - 220))
        total += loss
        adg_acc += adg; diar_acc += diar
    n = len(batches)
    total = total / n + 0.2 * np.sum((theta - PARAM_DEFAULT) ** 2)
    return total, {'ADG': adg_acc / n, 'diarrheaRate': diar_acc / n}
