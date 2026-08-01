"""
可视化梯度下降模拟结果
======================
运行: conda run -n base python visualize.py
输出: 4 张 PNG 图到 optimizer/
"""

import json
import os
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

RESULT_FILE = os.path.join(os.path.dirname(__file__), 'simulation_result.json')
OUTPUT_DIR = os.path.dirname(__file__)

with open(RESULT_FILE, 'r', encoding='utf-8') as f:
    data = json.load(f)

history = data['history']
epochs_arr = np.array([h['epoch'] for h in history])
loss_arr = np.array([h['loss'] for h in history])
adg_arr = np.array([h['ADG'] for h in history])
diar_arr = np.array([h['diarrheaRate'] for h in history])
theta_arr = np.array([h['theta'] for h in history])

names = data['theta_names']
theta_default = np.array(data['theta_default'])
theta_true = np.array(data['theta_true'])
theta_opt = np.array(data['theta_opt'])
theta_lower = np.array(data['theta_lower'])
theta_upper = np.array(data['theta_upper'])

# ============================================================
# 图1: 损失曲线
# ============================================================
fig, ax = plt.subplots(figsize=(10, 4))
ax.plot(epochs_arr, loss_arr, color='#2563eb', linewidth=1.5)
ax.axhline(0, color='#ccc', linewidth=0.5, linestyle='--')
ax.set_xlabel('迭代轮数')
ax.set_ylabel('损失')
ax.set_title('损失下降曲线')
ax.grid(True, alpha=0.3)
ax.text(epochs_arr[-1], loss_arr[-1], f'{loss_arr[-1]:.2f}',
        ha='left', va='bottom', fontsize=9, color='#2563eb')
fig.tight_layout()
fig.savefig(os.path.join(OUTPUT_DIR, 'fig1_loss.png'), dpi=150)
plt.close(fig)
print('图1: fig1_loss.png')

# ============================================================
# 图2: ADG + 腹泻率双轴
# ============================================================
fig, ax1 = plt.subplots(figsize=(10, 4))
ax2 = ax1.twinx()

ax1.plot(epochs_arr, adg_arr, color='#16a34a', linewidth=1.5, label='ADG (g/天)')
ax2.plot(epochs_arr, diar_arr * 100, color='#dc2626', linewidth=1.5, label='腹泻率 (%)')

ax1.set_xlabel('迭代轮数')
ax1.set_ylabel('ADG (g/天)', color='#16a34a')
ax2.set_ylabel('腹泻率 (%)', color='#dc2626')
ax1.set_title('ADG 与腹泻率变化')
ax1.grid(True, alpha=0.3)

lines1, labels1 = ax1.get_legend_handles_labels()
lines2, labels2 = ax2.get_legend_handles_labels()
ax1.legend(lines1 + lines2, labels1 + labels2, loc='upper right')

# 标注起止值
ax1.annotate(f'{adg_arr[0]:.1f}', xy=(epochs_arr[0], adg_arr[0]),
             fontsize=8, color='#16a34a', xytext=(5, 5),
             textcoords='offset points')
ax1.annotate(f'{adg_arr[-1]:.1f}', xy=(epochs_arr[-1], adg_arr[-1]),
             fontsize=8, color='#16a34a', xytext=(-20, -12),
             textcoords='offset points')
ax2.annotate(f'{diar_arr[0]*100:.1f}%', xy=(epochs_arr[0], diar_arr[0]*100),
             fontsize=8, color='#dc2626', xytext=(5, -10),
             textcoords='offset points')
ax2.annotate(f'{diar_arr[-1]*100:.1f}%', xy=(epochs_arr[-1], diar_arr[-1]*100),
             fontsize=8, color='#dc2626', xytext=(-20, 8),
             textcoords='offset points')

fig.tight_layout()
fig.savefig(os.path.join(OUTPUT_DIR, 'fig2_adg_diar.png'), dpi=150)
plt.close(fig)
print('图2: fig2_adg_diar.png')

# ============================================================
# 图3: 参数收敛（7子图）
# ============================================================
fig, axes = plt.subplots(3, 3, figsize=(14, 10))
axes_flat = axes.flatten()

for i in range(7):
    ax = axes_flat[i]
    ax.plot(epochs_arr, theta_arr[:, i], color='#2563eb', linewidth=1.5)
    ax.axhline(theta_default[i], color='#9ca3af', linewidth=1, linestyle='--', label='初始值')
    ax.axhline(theta_true[i], color='#f59e0b', linewidth=1, linestyle='--', label='真值')
    ax.axhline(theta_opt[i], color='#dc2626', linewidth=1, linestyle=':', label='最优值')
    ax.set_title(names[i])
    ax.grid(True, alpha=0.3)
    if i == 0:
        ax.legend(fontsize=7)

    # 上下界阴影
    ax.axhspan(theta_lower[i], theta_upper[i], alpha=0.05, color='#ccc')

# 隐藏第8子图（3×3=9，只用7个）
for j in range(7, 9):
    axes_flat[j].set_visible(False)

fig.suptitle('7 个参数收敛过程', fontsize=14, y=1.01)
fig.tight_layout()
fig.savefig(os.path.join(OUTPUT_DIR, 'fig3_params.png'), dpi=150)
plt.close(fig)
print('图3: fig3_params.png')

# ============================================================
# 图4: 参数初始 vs 最优对比柱状图
# ============================================================
fig, ax = plt.subplots(figsize=(10, 5))
x = np.arange(7)
width = 0.25

bars_default = ax.bar(x - width, theta_default, width, label='初始值', color='#9ca3af')
bars_opt = ax.bar(x, theta_opt, width, label='最优值', color='#2563eb')
bars_true = ax.bar(x + width, theta_true, width, label='真值', color='#f59e0b')

ax.set_xticks(x)
ax.set_xticklabels(names)
ax.set_ylabel('参数值')
ax.set_title('参数对比：初始值 vs 最优值 vs 真值')
ax.legend()
ax.grid(True, alpha=0.3, axis='y')

# 标注数值
for bar in bars_opt:
    h = bar.get_height()
    ax.text(bar.get_x() + bar.get_width() / 2, h + 0.01,
            f'{h:.3f}', ha='center', va='bottom', fontsize=7)

fig.tight_layout()
fig.savefig(os.path.join(OUTPUT_DIR, 'fig4_comparison.png'), dpi=150)
plt.close(fig)
print('图4: fig4_comparison.png')

# ============================================================
# 汇总
# ============================================================
print(f'\n4 张图已保存到 {OUTPUT_DIR}')
print('  fig1_loss.png        — 损失下降曲线')
print('  fig2_adg_diar.png    — ADG + 腹泻率双轴变化')
print('  fig3_params.png      — 7 参数收敛过程')
print('  fig4_comparison.png  — 参数初始 vs 最优 vs 真值对比')
