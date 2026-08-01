"""
梯度下降 V2 — RMSprop 逐参数归一化 + 学习率衰减 + 梯度裁剪
"""

import numpy as np
from gradient import numerical_gradient
from model import PARAM_NAMES, PARAM_RANGE

RMS_DECAY = 0.9
LR_DECAY = 0.96
LR_DECAY_STEP = 15


def train(theta0, batches, loss_fn, lr=0.3, epochs=200):
    theta = theta0.copy().astype(float)
    rms = np.zeros_like(theta) + 1e-8
    history = []

    lo = np.array([PARAM_RANGE[n][0] for n in PARAM_NAMES])
    hi = np.array([PARAM_RANGE[n][1] for n in PARAM_NAMES])

    for epoch in range(epochs):
        current_lr = lr * (LR_DECAY ** (epoch // LR_DECAY_STEP))

        grad = numerical_gradient(theta, batches, loss_fn)

        # RMSprop 更新
        rms = RMS_DECAY * rms + (1 - RMS_DECAY) * grad ** 2
        normalized_grad = grad / (np.sqrt(rms) + 1e-8)

        # 梯度裁剪
        gn = np.linalg.norm(normalized_grad)
        if gn > 30:
            normalized_grad = normalized_grad / gn * 30

        theta -= current_lr * normalized_grad
        theta = np.clip(theta, lo, hi)

        loss_val, metrics = loss_fn(theta, batches)
        history.append({
            'epoch': epoch, 'loss': loss_val,
            'ADG': metrics['ADG'], 'diarrheaRate': metrics['diarrheaRate'],
            'theta': theta.copy(),
        })

        if epoch % 10 == 0 or epoch == epochs - 1:
            tstr = ' '.join(f'{theta[i]:.3f}' for i in range(len(theta)))
            print(f'E{epoch:3d} L={loss_val:+.2f} ADG={metrics["ADG"]:.1f} '
                  f'Diar={metrics["diarrheaRate"]*100:.1f}% | {tstr}')

    return theta, history
