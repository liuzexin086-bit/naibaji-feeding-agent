import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type {
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

function requiredConfig(config: RunnableConfig) {
  const threadId = String(config.configurable?.thread_id ?? "");
  if (!threadId) throw new Error("NBJ_AGENT_CHECKPOINT_THREAD_REQUIRED");
  return {
    threadId,
    namespace: String(
      config.configurable?.checkpoint_ns || config.configurable?.nbj_request_id || "",
    ),
    checkpointId: String(config.configurable?.checkpoint_id ?? ""),
  };
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  throw new Error("NBJ_AGENT_CHECKPOINT_CORRUPT");
}

/** Node 24 built-in SQLite checkpoint saver; avoids native addon builds. */
export class NodeSqliteCheckpointSaver extends BaseCheckpointSaver<number> {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    super();
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_type TEXT NOT NULL,
        checkpoint BLOB NOT NULL,
        metadata_type TEXT NOT NULL,
        metadata BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_latest
        ON langgraph_checkpoints(thread_id, checkpoint_ns, created_at DESC, checkpoint_id DESC);
      CREATE TABLE IF NOT EXISTS langgraph_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = requiredConfig(config);
    const row = (key.checkpointId
      ? this.db.prepare(`SELECT * FROM langgraph_checkpoints
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`).get(
            key.threadId, key.namespace, key.checkpointId,
          )
      : this.db.prepare(`SELECT * FROM langgraph_checkpoints
          WHERE thread_id=? AND checkpoint_ns=?
          ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1`).get(
            key.threadId, key.namespace,
          )) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const checkpointId = String(row.checkpoint_id);
    const checkpoint = await this.serde.loadsTyped(
      String(row.checkpoint_type), bytes(row.checkpoint),
    ) as Checkpoint;
    const metadata = await this.serde.loadsTyped(
      String(row.metadata_type), bytes(row.metadata),
    ) as CheckpointMetadata;
    const writeRows = this.db.prepare(`SELECT task_id, channel, value_type, value
      FROM langgraph_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?
      ORDER BY task_id, idx`).all(key.threadId, key.namespace, checkpointId) as Array<Record<string, unknown>>;
    const pendingWrites = await Promise.all(writeRows.map(async (write) => [
      String(write.task_id),
      String(write.channel),
      await this.serde.loadsTyped(String(write.value_type), bytes(write.value)),
    ] as [string, string, unknown]));
    const checkpointConfig: RunnableConfig = {
      configurable: {
        ...config.configurable,
        thread_id: key.threadId,
        checkpoint_ns: key.namespace,
        nbj_request_id: config.configurable?.nbj_request_id,
        checkpoint_id: checkpointId,
      },
    };
    const parentId = row.parent_checkpoint_id ? String(row.parent_checkpoint_id) : "";
    return {
      config: checkpointConfig,
      checkpoint,
      metadata,
      pendingWrites,
      ...(parentId ? {
        parentConfig: {
          configurable: {
            thread_id: key.threadId,
            checkpoint_ns: key.namespace,
            checkpoint_id: parentId,
          },
        },
      } : {}),
    };
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const key = requiredConfig(config);
    const beforeId = String(options.before?.configurable?.checkpoint_id ?? "");
    const rows = this.db.prepare(`SELECT checkpoint_id FROM langgraph_checkpoints
      WHERE thread_id=? AND checkpoint_ns=?
      ${beforeId ? "AND checkpoint_id < ?" : ""}
      ORDER BY created_at DESC, checkpoint_id DESC
      ${options.limit ? "LIMIT ?" : ""}`);
    const args: Array<string | number> = [key.threadId, key.namespace];
    if (beforeId) args.push(beforeId);
    if (options.limit) args.push(options.limit);
    for (const row of rows.all(...args) as Array<{ checkpoint_id: string }>) {
      const tuple = await this.getTuple({ configurable: {
        ...config.configurable,
        checkpoint_id: row.checkpoint_id,
      } });
      if (tuple && (!options.filter || Object.entries(options.filter).every(
        ([name, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[name] === value,
      ))) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const key = requiredConfig(config);
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
    this.db.prepare(`INSERT OR REPLACE INTO langgraph_checkpoints
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
       checkpoint_type, checkpoint, metadata_type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        key.threadId,
        key.namespace,
        checkpoint.id,
        key.checkpointId || null,
        checkpointType,
        Buffer.from(checkpointBytes),
        metadataType,
        Buffer.from(metadataBytes),
        checkpoint.ts,
      );
    return { configurable: {
      ...config.configurable,
      thread_id: key.threadId,
      checkpoint_ns: key.namespace,
      nbj_request_id: config.configurable?.nbj_request_id,
      checkpoint_id: checkpoint.id,
    } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const key = requiredConfig(config);
    if (!key.checkpointId) throw new Error("NBJ_AGENT_CHECKPOINT_ID_REQUIRED");
    for (let index = 0; index < writes.length; index += 1) {
      const [channel, value] = writes[index];
      const writeIndex = WRITES_IDX_MAP[channel] ?? index;
      const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
      this.db.prepare(`INSERT OR REPLACE INTO langgraph_writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          key.threadId, key.namespace, key.checkpointId, taskId, writeIndex,
          channel, valueType, Buffer.from(valueBytes),
        );
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM langgraph_writes WHERE thread_id=?").run(threadId);
      this.db.prepare("DELETE FROM langgraph_checkpoints WHERE thread_id=?").run(threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const sharedCheckpointers = new Map<string, NodeSqliteCheckpointSaver>();

/** Returns one long-lived saver per database path; callers must not close it per request. */
export function getSharedCheckpointSaver(filename: string): NodeSqliteCheckpointSaver {
  const key = resolve(filename);
  const existing = sharedCheckpointers.get(key);
  if (existing) return existing;
  const saver = new NodeSqliteCheckpointSaver(filename);
  sharedCheckpointers.set(key, saver);
  return saver;
}

export function closeSharedCheckpointSavers(): void {
  // Call only after the server stops accepting requests and drains in-flight
  // runs (e.g. in the server "close" event) so no graph touches a closed DB.
  for (const [filename, saver] of [...sharedCheckpointers]) {
    try {
      saver.close();
      sharedCheckpointers.delete(filename);
    } catch {
      // Keep the entry so a later close retries instead of leaking a live handle.
    }
  }
}
