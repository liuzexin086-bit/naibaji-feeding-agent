"""
数值梯度 V2 — 相对步长 + 逐参数自适应
"""

import numpy as np


def numerical_gradient(theta, batches, loss_fn, eps_rel=1e-4):
    grad = np.zeros_like(theta)
    for i in range(len(theta)):
        eps = max(eps_rel, abs(theta[i]) * eps_rel)
        theta_p = theta.copy(); theta_p[i] += eps
        theta_m = theta.copy(); theta_m[i] -= eps
        Lp = sum(loss_fn(theta_p, [b])[0] for b in batches)
        Lm = sum(loss_fn(theta_m, [b])[0] for b in batches)
        grad[i] = (Lp - Lm) / (2 * eps)
    return grad
