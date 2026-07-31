import { DEFAULT_SOP_TEMPLATE } from "../sop/engine.js";

export const FEEDING_KNOWLEDGE = [
  {
    id: "sop-adaptation",
    title: "入栏与首次教奶",
    text: "记录实际入栏时间。17:00 仅在入栏后 8–10 小时窗口内使用，否则按实际入栏后 8 小时并记录流程偏差。",
  },
  {
    id: "sop-teaching",
    title: "首夜自动教奶程序",
    text: "首次教奶后连续 10 分钟轻柔驱赶。设备从断奶首日开始每 3 小时定时下奶，到次日 08:00 下奶并完成早间巡栏后结束。数量按 SOP 直接总量、SOP 参数推导、生产模型兜底的顺序确定；当前 SOP 以 35g/20头/次按有效头数和设备精度计算，设备只设置下粉量和下奶时间。",
  },
  {
    id: "sop-laggard",
    title: "掉队猪",
    text: "不主动到槽或腹部明显空瘪时建立个体标记，人工补奶 2–3 次，第三天必须人工评估去留。",
  },
  {
    id: "sop-water",
    title: "饮水策略",
    text: "12日龄前上料前关闭是当前场区策略，必须记录关闭、检查、恢复和操作人；脱水风险、严重腹泻、精神异常或兽医指令时阻断常规提示。",
  },
  {
    id: "sop-transition",
    title: "教槽与转料",
    text: "8–11日龄奶粉拌干料，12–14日龄奶料4:1奶泡料，20日龄后在采食、体况和粪便状态确认后安排每天2–3次过渡。",
  },
  {
    id: "sop-maintenance",
    title: "设备维护",
    text: "每两天清水循环和奶槽清洗，每七天深度循环清洗；批次结束检查粉仓、出粉口、主机、奶槽、干燥和防尘。",
  },
] as const;

export function searchKnowledge(query: string): {
  sopVersion: string;
  results: typeof FEEDING_KNOWLEDGE[number][];
} {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = FEEDING_KNOWLEDGE.map((item) => ({
    item,
    score: terms.reduce(
      (score, term) =>
        score + (`${item.title} ${item.text}`.toLowerCase().includes(term) ? 1 : 0),
      0,
    ),
  }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ item }) => item);
  return { sopVersion: DEFAULT_SOP_TEMPLATE.version, results: ranked };
}
