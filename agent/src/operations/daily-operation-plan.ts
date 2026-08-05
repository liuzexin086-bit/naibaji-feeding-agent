import { createHash } from "node:crypto";
import type { DailyOperationItem } from "../shared/local-store-contract.js";

export interface DailyOperationPlanSource {
  dayIndex: number;
  dayAge: number;
  endAge: number;
  sopConfig: Record<string, unknown>;
}

function operation(
  code: string,
  title: string,
  startLocal: string,
  endLocal: string,
  sopSection: string,
  requiredObservationFields: string[] = [],
  safetyNotes: string[] = [],
  endDayOffset?: 0 | 1,
): DailyOperationItem {
  return {
    code,
    title,
    dueWindow: { startLocal, endLocal, ...(endDayOffset === undefined ? {} : { endDayOffset }) },
    sopSection,
    requiredObservationFields,
    safetyNotes,
  };
}

function configuredInteger(config: Record<string, unknown>, key: string, fallback: number, min = 0): number {
  const value = config[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : fallback;
}

function configuredNumber(config: Record<string, unknown>, key: string, fallback: number, min = 0): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function configuredTime(config: Record<string, unknown>, key: string, legacyKey: string, fallback: string): string {
  const value = config[key] ?? config[legacyKey];
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function enabled(config: Record<string, unknown>, key: string): boolean {
  return config[key] !== false;
}

function stageOperation(source: DailyOperationPlanSource): DailyOperationItem {
  const config = source.sopConfig;
  const creepStart = configuredInteger(config, "creepAgeStart", 8, 1);
  const creepEnd = configuredInteger(config, "creepAgeEnd", 11, creepStart);
  if (enabled(config, "creepFeedEnabled") && source.dayAge >= creepStart && source.dayAge <= creepEnd) {
    return operation(
      "sop_creep_teaching", "教槽料诱食与采食观察", "10:00", "16:00", "SOP.教槽料",
      ["creepGrade", "feedingResponse"], ["仅记录观察结果；异常采食按 SOP 升级处理。"],
    );
  }
  const soakedStart = configuredInteger(config, "soakedFeedAgeStart", 12, 1);
  const soakedEnd = configuredInteger(config, "soakedFeedAgeEnd", 14, soakedStart);
  if (enabled(config, "soakedFeedEnabled") && source.dayAge >= soakedStart && source.dayAge <= soakedEnd) {
    const ratio = typeof config.soakedFeedRatio === "string" && config.soakedFeedRatio.trim()
      ? config.soakedFeedRatio.trim()
      : "4:1";
    return operation(
      "sop_ratio_transition", `水粉比过渡核验（${ratio}）`, "09:00", "12:00", "SOP.水粉过渡",
      ["dilutionRatio", "diarrheaGrade"], [`按 SOP ${ratio} 执行；腹泻或设备异常时不得自行放宽程序。`],
    );
  }
  const transitionStart = configuredInteger(config, "transitionAgeStart", 20, 1);
  if (enabled(config, "transitionEnabled") && (source.dayAge >= transitionStart || source.dayAge === source.endAge)) {
    return operation(
      "sop_weaning_transition", "断奶过渡与风险复核", "09:00", "15:00", "SOP.断奶过渡",
      ["creepGrade", "diarrheaGrade", "effectiveHeads"], ["断奶阶段异常应在当日记录并上报。"],
    );
  }
  return operation(
    "sop_daily_execution", "当日 SOP 程序执行复核", "09:00", "11:00", "SOP.日常执行",
    ["deviceStatus"], ["不得在未留痕的情况下更改设备策略。"],
  );
}

/**
 * The caller persists the returned exact list with the frozen SOP/device
 * references. Future SOP edits therefore cannot rewrite a materialized day.
 */
export function buildDailyOperationItems(source: DailyOperationPlanSource): DailyOperationItem[] {
  if (source.dayIndex === 0) {
    const firstTeaching = configuredTime(source.sopConfig, "teachingFirstLocal", "preferredFirstTeachingLocal", "17:00");
    const teachingEnd = configuredTime(source.sopConfig, "teachingEndLocal", "teachingProgramEndLocal", "08:00");
    const intervalHours = configuredNumber(source.sopConfig, "teachingIntervalHours", 3, 0.5);
    const powderPerTwenty = configuredNumber(source.sopConfig, "teachingPowderGramsPerTwenty", 35, 0.1);
    // D0 is a dedicated teaching-program day. Routine patrols, cleaning and
    // maintenance begin on D1 and must not be presented as first-day work.
    return [operation(
      "first_day_teaching", `首日教学程序启动（${powderPerTwenty} g/20头/次；每${intervalHours}小时）`, firstTeaching, teachingEnd, "SOP.首日教学",
      ["deviceStatus"], [`按 SOP 定量 ${powderPerTwenty} g/20头/次、每${intervalHours}小时执行；不得改为自由采食。`], 1,
    )];
  }
  const operations: DailyOperationItem[] = [
    operation(
      "daily_patrol", "日常巡栏", "09:00", "10:00", "SOP.日常巡栏",
      ["effectiveHeads", "diarrheaGrade"], ["发现死亡、虚弱或严重腹泻时，按应急 SOP 处置。"],
    ),
    operation(
      "device_program_check", "设备程序与卫生检查", "09:00", "10:30", "SOP.设备检查",
      ["deviceStatus"], ["先确认停机、堵塞和探头污染，再执行清洁或补料。"],
    ),
    stageOperation(source),
  ];
  const cleanEveryDays = configuredInteger(source.sopConfig, "standardCleanEveryDays", 2, 1);
  const deepCleanEveryDays = configuredInteger(source.sopConfig, "deepCleanEveryDays", 7, 1);
  if (enabled(source.sopConfig, "maintenanceEnabled") && source.dayIndex % cleanEveryDays === 0) {
    operations.push(operation(
      "preventive_maintenance", "预防性设备维护", "14:00", "16:00", "SOP.设备维护",
      ["deviceStatus"], ["断电、清洗和复位必须按设备安全规程执行。"],
    ));
  }
  if (enabled(source.sopConfig, "maintenanceEnabled") && source.dayIndex % deepCleanEveryDays === 0) {
    operations.push(operation(
      "weekly_deep_clean", "周期深度清洁", "16:00", "17:00", "SOP.清洁消毒",
      [], ["清洁后需复核探头和管路状态。"],
    ));
  }
  return operations;
}

export function digestDailyOperationItems(operations: DailyOperationItem[]): string {
  return createHash("sha256")
    .update(JSON.stringify(operations).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}
