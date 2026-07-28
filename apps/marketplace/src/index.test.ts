import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as marketplace from "./index.ts";

describe("marketplace package API", () => {
  it("exports the reviewed handler and listener for Task 11 composition", () => {
    assert.equal(typeof marketplace.createMarketplaceHandler, "function");
    assert.equal(typeof marketplace.startMarketplaceServer, "function");
  });
});
