# 奶爸机 — 饲喂参数梯度下降优化器

基于现有模型的纯 NumPy 梯度下降优化器，**不依赖 PyTorch**。

> **EXPERIMENTAL**
> **NOT FOR PRODUCTION**
> **现有旧参数输出已失效，禁止导入设备或生产模型。**

## 架构

```
simulate.py  (入口：生成模拟数据 → 训练 → 输出)
    ├── model.py      (可微前向传播)
    ├── loss.py       (损失函数 L = -ADG + λ₁×腹泻惩罚 + λ₂×正则)
    ├── gradient.py   (数值梯度：有限差分)
    └── train.py      (梯度下降主循环)
```

## 可调参数（V3，6个）

唯一生产参数合同为 `feeding-parameters-v3`，字段及单位：

| 字段 | 单位 | 范围 |
|---|---|---|
| `baseLevel` | ratio | 0.18–0.40 |
| `ramp` | ratio | 0.15–0.50 |
| `peakLevel` | ratio | 0.68–0.92 |
| `threshold` | grams-per-head | 150–220 |
| `dilution` | water-to-powder ratio | 5–8 |
| `diarrheaSensitivity` | dimensionless | 0.3–2.0 |

旧 7 参数向量一律由 `optimizer/contracts.py` 拒绝，禁止进入 V3 模型或生产路径。

## 运行

```bash
python simulate.py
```

## 输出

- 每 5 轮打印损失、ADG、腹泻率、参数值
- 结束后打印参数收敛对比 + 最终梯度
