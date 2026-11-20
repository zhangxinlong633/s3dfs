import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL, configuredModel, modelAllowed, modelParams } from "../src/config.ts";

describe("patrol model", () => {
  test("accepts the local 26B model and rejects anything smaller", () => {
    expect(modelAllowed(undefined)).toBe(true);
    expect(modelAllowed("")).toBe(true);
    expect(modelAllowed("26000000000")).toBe(true);
    expect(modelAllowed("25000000000")).toBe(false);
    expect(DEFAULT_MODEL).toBe("google/gemma-4-26b-a4b");
  });

  test("defaults to the LM Studio Gemma model", () => {
    expect(configuredModel({})).toBe("google/gemma-4-26b-a4b");
    expect(configuredModel({ S3DFS_PATROL_MODEL: "off" })).toBeNull();
    expect(modelParams({}, "google/gemma-4-26b-a4b")).toBe("26000000000");
    expect(modelParams({ S3DFS_PATROL_MODEL_PARAMS: "70000000000" }, "other")).toBe("70000000000");
  });
});
