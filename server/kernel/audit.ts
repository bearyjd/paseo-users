import { appendFile, mkdir, readFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { AuditEventSchema, type AuditEvent, type AuditEventType } from "../../shared/model.js";
import type { Clock } from "./clock.js";

export interface AuditLog {
  record(
    type: AuditEventType,
    fields?: { actorId?: string | null; targetId?: string | null; detail?: AuditEvent["detail"] },
  ): Promise<void>;
  list(options?: { limit?: number; type?: AuditEventType }): Promise<AuditEvent[]>;
}

/** Append-only JSON Lines, mode 0600. Records never contain secrets: callers pass ids and reasons only. */
export function createFileAuditLog(path: string, clock: Clock): AuditLog {
  let ready: Promise<void> | null = null;
  const ensure = () =>
    (ready ??= (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, "", { mode: 0o600 });
      await chmod(path, 0o600);
    })());
  return {
    async record(type, fields = {}) {
      await ensure();
      const event = AuditEventSchema.parse({
        at: clock.now().toISOString(),
        type,
        actorId: fields.actorId ?? null,
        targetId: fields.targetId ?? null,
        detail: fields.detail ?? {},
      });
      await appendFile(path, `${JSON.stringify(event)}\n`);
    },
    async list(options = {}) {
      await ensure();
      const text = await readFile(path, "utf8");
      const events: AuditEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        const parsed = AuditEventSchema.safeParse(JSON.parse(line));
        if (parsed.success && (!options.type || parsed.data.type === options.type)) events.push(parsed.data);
      }
      return events.slice(-(options.limit ?? 200)).reverse();
    },
  };
}

export function createMemoryAuditLog(clock: Clock): AuditLog & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(type, fields = {}) {
      events.push(
        AuditEventSchema.parse({
          at: clock.now().toISOString(),
          type,
          actorId: fields.actorId ?? null,
          targetId: fields.targetId ?? null,
          detail: fields.detail ?? {},
        }),
      );
    },
    async list(options = {}) {
      const filtered = options.type ? events.filter((e) => e.type === options.type) : events;
      return filtered.slice(-(options.limit ?? 200)).reverse();
    },
  };
}
