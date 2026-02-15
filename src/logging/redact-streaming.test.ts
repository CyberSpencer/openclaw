import { describe, expect, it } from "vitest";
import { createStreamingSensitiveRedactor } from "./redact-streaming.js";
import { getDefaultRedactPatterns } from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("createStreamingSensitiveRedactor", () => {
  it("passes through text when mode=off", () => {
    const redactor = createStreamingSensitiveRedactor({ mode: "off" });
    expect(redactor.process("hello ")).toBe("hello ");
    expect(redactor.process("world")).toBe("world");
    expect(redactor.finalize()).toBe("");
  });

  it("does not leak bearer token split across chunks", () => {
    const redactor = createStreamingSensitiveRedactor({
      mode: "tools",
      patterns: defaults,
    });

    const out1 = redactor.process("Authorization: Bearer abcdef1234");
    expect(out1).not.toContain("abcdef1234");

    const out2 = redactor.process("567890ghij\n");
    const out3 = redactor.finalize();

    const combined = `${out1}${out2}${out3}`;
    expect(combined).not.toContain("abcdef1234567890ghij");
    expect(combined).toContain("Authorization: Bearer abcdef…ghij");
  });

  it("does not leak env assignment split across chunks", () => {
    const redactor = createStreamingSensitiveRedactor({
      mode: "tools",
      patterns: defaults,
    });

    const out1 = redactor.process("OPENAI_API_KEY=sk-123");
    expect(out1).not.toContain("sk-123");

    const out2 = redactor.process("4567890abcdef\n");
    const out3 = redactor.finalize();

    const combined = `${out1}${out2}${out3}`;
    expect(combined).not.toContain("sk-1234567890abcdef");
    expect(combined).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("emits non-sensitive text incrementally", () => {
    const redactor = createStreamingSensitiveRedactor({
      mode: "tools",
      patterns: defaults,
    });

    expect(redactor.process("hello ")).toBe("hello ");
    expect(redactor.process("world")).toBe("world");
    expect(redactor.finalize()).toBe("");
  });
});
