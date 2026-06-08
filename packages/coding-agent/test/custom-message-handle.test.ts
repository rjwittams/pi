import assert from "node:assert";
import type { MessageHandle } from "@earendil-works/pi-tui";
import { beforeAll, describe, it } from "vitest";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("CustomMessageComponent plumbs MessageHandle through MessageRenderOptions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("passes a non-undefined handle to the registered renderer factory", () => {
		let received: MessageHandle | undefined;
		const renderer: MessageRenderer = (_message, options) => {
			received = options.handle;
			return undefined;
		};
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "demo",
			content: "test",
			details: undefined,
			display: true,
			timestamp: Date.now(),
		};
		const _component = new CustomMessageComponent(message, renderer, undefined, undefined);
		assert.ok(received, "renderer factory must receive a MessageHandle");
		assert.strictEqual(typeof received.getRect, "function");
		assert.strictEqual(typeof received.onRectChange, "function");
		assert.strictEqual(typeof received.onPointer, "function");
		assert.strictEqual(typeof received.focus, "function");
		assert.strictEqual(typeof received.unfocus, "function");
		assert.strictEqual(typeof received.isFocused, "function");
		assert.strictEqual(received.getRect(), undefined, "rect is initially undefined (no render yet)");
	});

	it("onRectChange returns an unsubscribe function and fires once immediately", () => {
		let received: MessageHandle | undefined;
		const renderer: MessageRenderer = (_message, options) => {
			received = options.handle;
			return undefined;
		};
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "demo",
			content: "test",
			details: undefined,
			display: true,
			timestamp: Date.now(),
		};
		const _component = new CustomMessageComponent(message, renderer, undefined, undefined);
		assert.ok(received);
		const seen: (import("@earendil-works/pi-tui").SurfaceRect | undefined)[] = [];
		const off = received.onRectChange((rect) => seen.push(rect));
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0], undefined);
		off();
	});
});
