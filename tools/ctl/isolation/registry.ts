import { createRegistry } from "./index.js";
import { sameUser } from "./same-user.js";
import { unixAccount } from "./unix-account.js";

/** Add a future strategy (for example rootless Podman) here and nowhere else. */
export const defaultRegistry = createRegistry([sameUser, unixAccount]);
export const DEFAULT_ISOLATION = "same-user";
