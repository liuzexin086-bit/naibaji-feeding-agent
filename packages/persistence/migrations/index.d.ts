import type { DatabaseSync } from "node:sqlite";

export declare const AGENT_APPLICATION_VERSION = "0.1.0";
export declare const LEGACY_APPLICATION_VERSION = "legacy-unknown";
export declare const SEALED_V12_NAME = "audited-schema-v12-baseline";
export declare const SEALED_V12_CHECKSUM = "0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E";
export declare const CURRENT_MIGRATION_VERSION = 16;
export declare const SEALED_V14_NAME = "registered-schema-v14-import";
export declare const SEALED_V15_NAME = "registered-schema-v15-import-evidence";
export declare const SEALED_V15_CHECKSUM = "22DAC823AA20D7401C3BD5F4A6EA83CC9C037D2AAE3A14B56E1683A90490D08F";
export declare const SEALED_V16_NAME = "registered-schema-v16-sealed-restore-evidence";
export declare const SEALED_V16_CHECKSUM = "F79E3F38925EDAF819D7D9CEF19DF36E02FF9BD8258C8BFA980DA6FC5014366D";

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly canonicalBody: string;
  readonly checksum: string;
  readonly apply: () => void;
}

export interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applicationVersion: string;
  readonly appliedAt: string;
}

export declare function migrationChecksum(input: {
  version: number;
  name: string;
  canonicalBody: string;
}): string;
export declare function defineMigration(input: {
  version: number;
  name: string;
  canonicalBody: string;
  apply: () => void;
}): MigrationDefinition;
export declare function validateMigrationRegistry(
  migrations: readonly MigrationDefinition[],
): void;
export declare function validateAppliedMigrations(
  migrations: readonly MigrationDefinition[],
  appliedRows: readonly AppliedMigrationRow[],
): void;
export declare function prepareMigrationLedger(
  database: DatabaseSync,
  baseline: MigrationDefinition,
): AppliedMigrationRow[];
export declare function applyPendingMigrations(input: {
  database: DatabaseSync;
  migrations: readonly MigrationDefinition[];
  appliedRows: readonly AppliedMigrationRow[];
  applicationVersion: string;
  now?: () => string;
}): void;
export declare function runMigrationLedger(input: {
  database: DatabaseSync;
  migrations: readonly MigrationDefinition[];
  applicationVersion: string;
  now?: () => string;
  beforeApply?: () => void;
}): void;
export declare function defineNaibajiMigrationChain(
  database: DatabaseSync,
): readonly MigrationDefinition[];
export declare function runNaibajiMigrations(input: {
  database: DatabaseSync;
  applicationVersion?: string;
  now?: () => string;
}): void;
