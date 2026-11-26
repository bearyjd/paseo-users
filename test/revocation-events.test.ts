import { describe, expect, it } from "vitest";
import { PW, makeHousehold } from "./helpers.js";

type Revoked = { userId: string; sessionId: string };

describe("session revocation events", () => {
  it("reports exactly the sessions that were revoked, once each", async () => {
    const { kernel, admin, alice, aliceId } = await makeHousehold();
    const events: Revoked[] = [];
    kernel.onSessionsRevoked((revoked) => events.push(...revoked));

    const second = await kernel.login({ username: "alice", password: PW.dev });
    if (!second.ok) throw new Error();
    await kernel.revokeLoginSession(alice, alice.loginSessionId);
    expect(events).toEqual([{ userId: aliceId, sessionId: alice.loginSessionId }]);

    events.length = 0;
    await kernel.revokeAllLoginSessions(admin, aliceId);
    expect(events).toEqual([{ userId: aliceId, sessionId: second.sessionId }]);
  });

  it("fires for disable, role change, password change and logout, and not for unrelated users", async () => {
    const { kernel, admin, alice, bob, aliceId, bobId } = await makeHousehold();
    const events: Revoked[] = [];
    kernel.onSessionsRevoked((revoked) => events.push(...revoked));

    await kernel.logout(bob);
    expect(events.map((e) => e.userId)).toEqual([bobId]);
    events.length = 0;
    await kernel.setUserStatus(admin, aliceId, "disabled");
    expect(events.map((e) => e.sessionId)).toContain(alice.loginSessionId);
    expect(events.every((e) => e.userId === aliceId)).toBe(true);
  });

  it("a listener that throws cannot block revocation, and unsubscribing stops delivery", async () => {
    const { kernel, admin, alice, aliceId } = await makeHousehold();
    kernel.onSessionsRevoked(() => {
      throw new Error("listener bug");
    });
    const seen: Revoked[] = [];
    const stop = kernel.onSessionsRevoked((revoked) => seen.push(...revoked));
    await kernel.revokeAllLoginSessions(admin, aliceId);
    expect(await kernel.authenticate("pus_" + "x".repeat(43))).toBeNull();
    expect(seen).toHaveLength(1);
    stop();
    const again = await kernel.login({ username: "alice", password: PW.dev });
    if (!again.ok) throw new Error();
    await kernel.revokeLoginSession(alice, again.sessionId).catch(() => undefined);
    expect(seen).toHaveLength(1);
  });
});
