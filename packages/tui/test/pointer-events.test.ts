import assert from "node:assert";
import { describe, it } from "node:test";
import { parsePointerEvent } from "../src/pointer-events.ts";

describe("parsePointerEvent", () => {
	it("parses a left-button press", () => {
		const ev = parsePointerEvent("\x1b[<0;10;5M");
		assert.deepStrictEqual(ev, {
			type: "pointerdown",
			row: 4,
			col: 9,
			button: 0,
			buttons: 1,
			deltaX: 0,
			deltaY: 0,
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
		});
	});

	it("parses a left-button release", () => {
		const ev = parsePointerEvent("\x1b[<0;10;5m");
		assert.strictEqual(ev?.type, "pointerup");
		assert.strictEqual(ev?.button, 0);
		assert.strictEqual(ev?.buttons, 0);
	});

	it("parses a middle-button press", () => {
		const ev = parsePointerEvent("\x1b[<1;3;7M");
		assert.strictEqual(ev?.button, 1);
		assert.strictEqual(ev?.buttons, 2);
	});

	it("parses a right-button press", () => {
		const ev = parsePointerEvent("\x1b[<2;3;7M");
		assert.strictEqual(ev?.button, 2);
		assert.strictEqual(ev?.buttons, 4);
	});

	it("parses a motion event with no buttons (button=35)", () => {
		const ev = parsePointerEvent("\x1b[<35;20;10M");
		assert.strictEqual(ev?.type, "pointermove");
		assert.strictEqual(ev?.button, 3);
		assert.strictEqual(ev?.buttons, 0);
	});

	it("parses a drag event with left button held (button=32)", () => {
		const ev = parsePointerEvent("\x1b[<32;20;10M");
		assert.strictEqual(ev?.type, "pointermove");
		assert.strictEqual(ev?.buttons, 1);
	});

	it("parses a wheel-up event (button=64)", () => {
		const ev = parsePointerEvent("\x1b[<64;5;3M");
		assert.strictEqual(ev?.type, "wheel");
		assert.strictEqual(ev?.deltaY, -1);
	});

	it("parses a wheel-down event (button=65)", () => {
		const ev = parsePointerEvent("\x1b[<65;5;3M");
		assert.strictEqual(ev?.type, "wheel");
		assert.strictEqual(ev?.deltaY, 1);
	});

	it("decodes shift modifier (button|=4)", () => {
		const ev = parsePointerEvent("\x1b[<4;10;5M");
		assert.strictEqual(ev?.shiftKey, true);
		assert.strictEqual(ev?.altKey, false);
		assert.strictEqual(ev?.ctrlKey, false);
		assert.strictEqual(ev?.button, 0);
	});

	it("decodes alt modifier (button|=8)", () => {
		const ev = parsePointerEvent("\x1b[<8;10;5M");
		assert.strictEqual(ev?.altKey, true);
		assert.strictEqual(ev?.button, 0);
	});

	it("decodes ctrl modifier (button|=16)", () => {
		const ev = parsePointerEvent("\x1b[<16;10;5M");
		assert.strictEqual(ev?.ctrlKey, true);
		assert.strictEqual(ev?.button, 0);
	});

	it("returns undefined for non-pointer sequences", () => {
		assert.strictEqual(parsePointerEvent("hello"), undefined);
		assert.strictEqual(parsePointerEvent("\x1b[A"), undefined);
		assert.strictEqual(parsePointerEvent("\x1b[<bad"), undefined);
	});

	it("returns undefined for malformed SGR mouse sequences", () => {
		assert.strictEqual(parsePointerEvent("\x1b[<0;10M"), undefined);
		assert.strictEqual(parsePointerEvent("\x1b[<0;10;5"), undefined);
	});
});
