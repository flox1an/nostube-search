import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getExplicitContentWarning,
  hasNsfwPlatformAttributes,
} from "./nsfw-platform-detection.js";

describe("NSFW platform detection", () => {
  it("detects the supplied xHamster import attributes", () => {
    assert.equal(
      hasNsfwPlatformAttributes([
        ["d", "xhamster-xhvyK3N"],
        ["source", "xhamster"],
      ]),
      true,
    );
  });

  it("matches d prefixes and exact source values case-insensitively", () => {
    assert.equal(hasNsfwPlatformAttributes([["d", "  XHAMSTER-video"]]), true);
    assert.equal(hasNsfwPlatformAttributes([["source", " XhAmStEr "]]), true);
  });

  it("detects a matching value in any repeated d or source tag", () => {
    assert.equal(
      hasNsfwPlatformAttributes([
        ["source", "youtube"],
        ["source", "xhamster"],
      ]),
      true,
    );
  });

  it("does not match unrelated attributes or source prefixes", () => {
    assert.equal(hasNsfwPlatformAttributes([["d", "youtube-video"]]), false);
    assert.equal(
      hasNsfwPlatformAttributes([["source", "xhamster-mirror"]]),
      false,
    );
  });

  it("preserves explicit warnings and ignores whitespace-only warnings", () => {
    assert.equal(
      getExplicitContentWarning([["content-warning", "Graphic violence"]]),
      "Graphic violence",
    );
    assert.equal(
      getExplicitContentWarning([["content-warning", "  "]]),
      undefined,
    );
  });
});
