"""
数值梯度 V2 — 相对步长 + 逐参数自适应
"""

import numpy as np

from contracts import PARAM_RANGE


def numerical_gradient(theta, batches, loss_fn, eps_rel=1e-4):
    grad = np.zeros_like(theta)
    lo = np.array([PARAM_RANGE[name][0] for name in PARAM_RANGE])
    hi = np.array([PARAM_RANGE[name][1] for name in PARAM_RANGE])
    for i in range(len(theta)):
        eps = max(eps_rel, abs(theta[i]) * eps_rel)
        theta_p = theta.copy(); theta_p[i] = np.clip(theta[i] + eps, lo[i], hi[i])
        theta_m = theta.copy(); theta_m[i] = np.clip(theta[i] - eps, lo[i], hi[i])
        span = float(theta_p[i] - theta_m[i])
        if span == 0:
            span = eps
        Lp = sum(loss_fn(theta_p, [b])[0] for b in batches)
        Lm = sum(loss_fn(theta_m, [b])[0] for b in batches)
        grad[i] = (Lp - Lm) / span
    return grad
