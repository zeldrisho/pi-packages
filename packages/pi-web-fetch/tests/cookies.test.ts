import { describe, expect, it } from "vite-plus/test";
import { CookieJar } from "../src/network/cookies.ts";

function response(...setCookies: string[]) {
  return { headers: { "set-cookie": setCookies } };
}

describe("CookieJar", () => {
  it("stores and sends cookies for the response origin", () => {
    const jar = new CookieJar();

    jar.store(response("session=abc; Path=/"), new URL("https://example.test/login"));

    expect(jar.headerFor(new URL("https://example.test/page"))).toBe("session=abc");
  });

  it("does not send cookies to another origin", () => {
    const jar = new CookieJar();

    jar.store(response("session=abc; Path=/"), new URL("https://example.test/"));

    expect(jar.headerFor(new URL("https://other.test/"))).toBeUndefined();
  });

  it("withholds Secure cookies from plain HTTP", () => {
    const jar = new CookieJar();

    jar.store(response("session=abc; Path=/; Secure"), new URL("https://example.test/"));

    expect(jar.headerFor(new URL("https://example.test/"))).toBe("session=abc");
    expect(jar.headerFor(new URL("http://example.test/"))).toBeUndefined();
  });

  it("orders longer cookie paths first", () => {
    const jar = new CookieJar();

    jar.store(response("root=1; Path=/"), new URL("https://example.test/"));
    jar.store(response("deep=2; Path=/a/b"), new URL("https://example.test/a/b"));

    expect(jar.headerFor(new URL("https://example.test/a/b/c"))).toBe("deep=2; root=1");
    expect(jar.headerFor(new URL("https://example.test/a/c"))).toBe("root=1");
  });

  it("applies the default directory path when Path is absent", () => {
    const jar = new CookieJar();

    jar.store(response("scoped=1"), new URL("https://example.test/a/b/page"));

    expect(jar.headerFor(new URL("https://example.test/a/b/other"))).toBe("scoped=1");
    expect(jar.headerFor(new URL("https://example.test/a/other"))).toBeUndefined();
  });

  it("deletes cookies with a non-positive Max-Age", () => {
    const jar = new CookieJar();

    jar.store(response("session=abc; Path=/"), new URL("https://example.test/"));
    jar.store(response("session=; Path=/; Max-Age=0"), new URL("https://example.test/"));

    expect(jar.headerFor(new URL("https://example.test/"))).toBeUndefined();
  });

  it("ignores cookies whose Expires is already in the past", () => {
    const jar = new CookieJar();

    jar.store(
      response("session=abc; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
      new URL("https://example.test/"),
    );

    expect(jar.headerFor(new URL("https://example.test/"))).toBeUndefined();
  });

  it("rejects Domain attributes that cannot match the response host", () => {
    const jar = new CookieJar();

    jar.store(response("a=1; Domain=other.test"), new URL("https://example.test/"));
    jar.store(response("b=2; Domain=example.test"), new URL("https://example.test/"));

    expect(jar.headerFor(new URL("https://example.test/"))).toBe("b=2");
  });

  it("ignores malformed and control-character cookies", () => {
    const jar = new CookieJar();

    jar.store(
      response("=value", "novalue", "a=va\u0000lue", "ok=1; Path=/"),
      new URL("https://example.test/"),
    );

    expect(jar.headerFor(new URL("https://example.test/"))).toBe("ok=1");
  });

  it("overwrites a cookie with the same name, origin, and path", () => {
    const jar = new CookieJar();

    jar.store(response("session=first; Path=/"), new URL("https://example.test/"));
    jar.store(response("session=second; Path=/"), new URL("https://example.test/"));

    expect(jar.headerFor(new URL("https://example.test/"))).toBe("session=second");
    expect(jar.size).toBe(1);
  });

  it("stores a solver token for the target origin only", () => {
    const jar = new CookieJar();

    expect(jar.set("aws-waf-token", "solved:token", new URL("https://example.test/page"))).toBe(
      true,
    );
    expect(jar.headerFor(new URL("https://example.test/other"))).toBe("aws-waf-token=solved:token");
    expect(jar.headerFor(new URL("https://other.test/"))).toBeUndefined();
  });

  it("rejects unsafe solver tokens", () => {
    const jar = new CookieJar();
    const url = new URL("https://example.test/");

    expect(jar.set("aws-waf-token", "bad;token", url)).toBe(false);
    expect(jar.set("aws-waf-token", "bad token", url)).toBe(false);
    expect(jar.set("aws-waf-token", "bad\u0000token", url)).toBe(false);
    expect(jar.set("bad name", "token", url)).toBe(false);
    expect(jar.size).toBe(0);
  });

  it("bounds the number of retained cookies", () => {
    const jar = new CookieJar();

    for (let index = 0; index < 140; index += 1) {
      jar.store(response(`c${index}=1; Path=/`), new URL("https://example.test/"));
    }

    expect(jar.size).toBeLessThanOrEqual(128);
    expect(jar.headerFor(new URL("https://example.test/"))).not.toContain("c0=1");
  });
});
