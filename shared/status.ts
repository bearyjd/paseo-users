import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const StatusSchema = z.object({
  plugin: z.literal("paseo-users"),
  version: z.string(),
  /**
   * `none`: this plugin is NOT an access boundary. The daemon admits one shared principal and
   * plugin RPC handlers receive no caller identity. Anyone relying on the "users" in this
   * plugin for separation is not protected. See docs/02-sdk-capability-matrix.md.
   */
  enforcement: z.enum(["none", "enforced"]),
  contractVersion: z.literal(1),
  blockedBy: z.array(z.string()),
});
export type Status = z.infer<typeof StatusSchema>;

export const statusRpc = defineRpc({
  name: "users.status.get",
  input: z.object({}),
  output: StatusSchema,
});
