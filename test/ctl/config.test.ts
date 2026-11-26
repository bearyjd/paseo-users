import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { createRegistry } from "../../tools/ctl/isolation/index.js";
import { cfg } from "./helpers.js";

const fails = (raw: unknown, re: RegExp) => {
  try {
    parseConfig(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).message).toMatch(re);
    return;
  }
  throw new Error("expected ConfigError");
};

describe("config validation", () => {
  it("accepts a minimal config and assigns ports from basePort", () => {
    const c = parseConfig(cfg());
    expect(c.people.map((p) => [p.name, p.isolation, p.port])).toEqual([
      ["ann", "same-user", 7100],
      ["bob", "same-user", 7101],
    ]);
    expect(c.homeBase).toBe("/home/tester/.paseo-people");
  });

  it.each(["A", "a", "1ab", "a b", "a.b", "x".repeat(33), ""])("rejects bad name %j", (name) => {
    fails(cfg({ people: [{ name }] }), /name/);
  });

  it("rejects duplicate names and ports", () => {
    fails(cfg({ people: [{ name: "ann" }, { name: "ann" }] }), /duplicate person name/);
    fails(cfg({ people: [{ name: "ann", port: 7200 }, { name: "bob", port: 7200 }] }), /duplicate port/);
  });

  it("rejects ports below 1024 or above 65535", () => {
    fails(cfg({ people: [{ name: "ann", port: 80 }] }), /1024/);
    fails(cfg({ people: [{ name: "ann", port: 70000 }] }), /port/);
  });

  it("rejects a collision with an existing daemon and skips existing ports when assigning", () => {
    fails(cfg({ existingDaemons: [{ name: "main", port: 7200 }], people: [{ name: "ann", port: 7200 }] }), /collides with existing daemon "main"/);
    const c = parseConfig(cfg({ existingDaemons: [{ name: "main", port: 7100 }] }));
    expect(c.people.map((p) => p.port)).toEqual([7101, 7102]);
  });

  it("refuses 6767 unless allowDefaultPort, and never assigns it automatically", () => {
    fails(cfg({ people: [{ name: "ann", port: 6767 }] }), /6767.*allowDefaultPort/);
    expect(parseConfig(cfg({ allowDefaultPort: true, people: [{ name: "ann", port: 6767 }] })).people[0]?.port).toBe(6767);
    const c = parseConfig({ ...cfg(), basePort: 6766, people: [{ name: "ann" }, { name: "bob" }] });
    expect(c.people.map((p) => p.port)).toEqual([6766, 6768]);
  });

  it("allows the existing daemon to sit on 6767", () => {
    expect(() => parseConfig(cfg({ existingDaemons: [{ name: "main", port: 6767 }] }))).not.toThrow();
  });

  it.each(["0.0.0.0", "::", "[::]"])("rejects listenAddress %s without allowAllInterfaces", (a) => {
    fails(cfg({ listenAddress: a }), /allowAllInterfaces|listenAddress/);
  });

  it("accepts all interfaces when explicitly allowed", () => {
    expect(() => parseConfig(cfg({ listenAddress: "0.0.0.0", allowAllInterfaces: true }))).not.toThrow();
  });

  it("never lets a PASEO_HOME be, or sit inside, the default ~/.paseo", () => {
    fails(cfg({ homeBase: "/home/tester/.paseo" }), /default ~\/\.paseo/);
    fails(cfg({ homeBase: "/home/tester/.paseo/people" }), /default ~\/\.paseo/);
    fails(cfg({ homeBase: "/home/tester" }), /userHome/);
    expect(parseConfig(cfg()).homeBase).not.toBe("/home/tester/.paseo");
  });

  it("requires unixAccount for unix-account and rejects root and duplicates", () => {
    fails(cfg({ people: [{ name: "ann", isolation: "unix-account" }] }), /requires unixAccount/);
    fails(cfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "root" }] }), /root/);
    fails(
      cfg({
        people: [
          { name: "ann", isolation: "unix-account", unixAccount: "svc" },
          { name: "bob", isolation: "unix-account", unixAccount: "svc" },
        ],
      }),
      /duplicate unixAccount/,
    );
    fails(cfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "Bad Name" }] }), /POSIX/);
    fails(cfg({ people: [{ name: "ann", unixAccount: "svc" }] }), /unixAccount is ignored/);
  });

  it("rejects unsafe paths and unknown keys", () => {
    fails(cfg({ paseoBinary: "paseo" }), /absolute/);
    fails(cfg({ userHome: "/home/a b" }), /absolute/);
    fails(cfg({ paseoBinary: "/opt/../bin/paseo" }), /absolute/);
    fails(cfg({ surprise: 1 }), /surprise|Unrecognized/);
  });

  it("rejects an unknown isolation id (registry fails closed)", () => {
    fails(cfg({ people: [{ name: "ann", isolation: "podman" }] }), /unknown isolation "podman"/);
    expect(() => createRegistry([]).get("x")).toThrow(/unknown isolation strategy/);
  });
});
