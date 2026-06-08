import assert from "node:assert";
import { describe, it } from "node:test";
import type { MessageHandle, SurfaceHandle } from "../src/index.ts";

describe("MessageHandle type", () => {
	it("is assignable to SurfaceHandle (extends with no additions)", () => {
		const stub: MessageHandle = {
			getRect: () => undefined,
			onRectChange: () => () => {},
			onPointer: () => () => {},
			focus: () => {},
			unfocus: () => {},
			isFocused: () => false,
		};
		const surface: SurfaceHandle = stub;
		assert.strictEqual(typeof surface.getRect, "function");
		assert.strictEqual(typeof surface.onPointer, "function");
		assert.strictEqual(typeof surface.focus, "function");
	});
});
