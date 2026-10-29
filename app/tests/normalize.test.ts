import { describe, it, expect } from "vitest";
import cases from "../../shared/normalization-cases.json";
import { matches } from "../electron/guard/normalize";
describe("shared golden semantics", () => {
  for (const [i, c] of cases.entries())
    it(`golden ${i}`, () => expect(matches(c.term, c.message)).toBe(c.match));
});
