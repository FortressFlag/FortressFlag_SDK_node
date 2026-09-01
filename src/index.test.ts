import { expect, test } from "vitest";
import { SDK_NAME } from "./index.js";

test("the scaffold module loads", () => {
  expect(SDK_NAME).toBe("@fortressflag/sdk-node");
});
