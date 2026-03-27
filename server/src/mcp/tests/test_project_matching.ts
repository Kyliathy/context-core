import { describe, expect, test } from "bun:test";
import { matchesAnyProject } from "../tools/search.js";

describe("matchesAnyProject — substring project matching", () =>
{
  test("exact match works", () =>
  {
    expect(matchesAnyProject("AXON", ["AXON"])).toBe(true);
  });

  test("case-insensitive match", () =>
  {
    expect(matchesAnyProject("AXON", ["axon"])).toBe(true);
  });

  test("substring prefix match: 'reach2' matches 'reach2-web'", () =>
  {
    expect(matchesAnyProject("reach2-web", ["reach2"])).toBe(true);
  });

  test("substring suffix match: 'reach2' matches 'zz-reach2'", () =>
  {
    expect(matchesAnyProject("zz-reach2", ["reach2"])).toBe(true);
  });

  test("substring mid-word match: 'xon' matches 'AXON'", () =>
  {
    expect(matchesAnyProject("AXON", ["xon"])).toBe(true);
  });

  test("case-insensitive substring: 'reach2' matches 'ZZ-Reach2'", () =>
  {
    expect(matchesAnyProject("ZZ-Reach2", ["reach2"])).toBe(true);
  });

  test("no match returns false", () =>
  {
    expect(matchesAnyProject("AXON", ["nexus"])).toBe(false);
  });

  test("empty patterns matches everything", () =>
  {
    expect(matchesAnyProject("AXON", [])).toBe(true);
    expect(matchesAnyProject("anything", [])).toBe(true);
  });

  test("multiple patterns — matches if any pattern hits", () =>
  {
    expect(matchesAnyProject("zz-reach2", ["axon", "reach2"])).toBe(true);
  });

  test("multiple patterns — no match if none hit", () =>
  {
    expect(matchesAnyProject("AXON", ["reach2", "nexus"])).toBe(false);
  });
});
