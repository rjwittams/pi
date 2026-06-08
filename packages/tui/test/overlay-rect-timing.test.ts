import assert from "node:assert";
import { describe, it } from "node:test";
import type { SurfaceRect } from "../src/index.ts";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	render(): string[] {
		return ["X"];
	}
	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

async function flush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("OverlayHandle.onRectChange listener firing timing", () => {
	it("delivers the initial rect synchronously inside onRectChange", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		tui.start();
		try {
			const handle = tui.showOverlay(new StaticOverlay(), { width: 1, height: 1, anchor: "top-left" });
			await flush(tui, terminal);

			// At this point handle.lastRect is populated. A subscriber should receive it synchronously.
			const calls: Array<SurfaceRect | undefined> = [];
			handle.onRectChange((rect) => calls.push(rect));
			assert.strictEqual(calls.length, 1, "initial delivery must fire synchronously inside onRectChange()");
			assert.ok(calls[0], "initial rect should be defined for a visible overlay");
		} finally {
			tui.stop();
		}
	});

	it("does not fire change listeners synchronously when the rect changes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		tui.start();
		try {
			const handle = tui.showOverlay(new StaticOverlay(), { width: 1, height: 1, anchor: "top-left" });
			await flush(tui, terminal);

			const calls: Array<SurfaceRect | undefined> = [];
			handle.onRectChange((rect) => calls.push(rect));
			// Drain the initial synchronous delivery.
			calls.length = 0;

			// Toggle hidden state to force a rect change.
			handle.setHidden(true);

			// The listener must not have fired synchronously at this point.
			assert.strictEqual(calls.length, 0, "listener must not fire synchronously on rect change");

			// After a render flush the deferred callback must have fired.
			await flush(tui, terminal);
			assert.ok(calls.length > 0, "listener should have fired after a render flush");
			assert.strictEqual(calls[0], undefined, "rect should be undefined for a hidden overlay");
		} finally {
			tui.stop();
		}
	});
});
