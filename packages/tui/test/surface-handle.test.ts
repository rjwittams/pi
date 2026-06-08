import assert from "node:assert";
import { describe, it } from "node:test";
import type { OverlayHandle, SurfaceHandle } from "../src/index.ts";
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

describe("SurfaceHandle abstraction", () => {
	it("OverlayHandle is assignable to SurfaceHandle", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		tui.start();
		try {
			const handle: OverlayHandle = tui.showOverlay(new StaticOverlay(), {
				width: 1,
				height: 1,
				anchor: "top-left",
			});
			const surface: SurfaceHandle = handle;
			await flush(tui, terminal);
			const rect = surface.getRect();
			assert.ok(rect, "surface.getRect must return a rect for a visible overlay");
			assert.strictEqual(rect.row, 0);
			assert.strictEqual(rect.col, 0);
		} finally {
			tui.stop();
		}
	});

	it("SurfaceHandle exposes getRect, onRectChange, onPointer, focus, unfocus, isFocused", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		tui.start();
		try {
			const handle = tui.showOverlay(new StaticOverlay(), { width: 1, height: 1, anchor: "top-left" });
			const surface: SurfaceHandle = handle;
			assert.strictEqual(typeof surface.getRect, "function");
			assert.strictEqual(typeof surface.onRectChange, "function");
			assert.strictEqual(typeof surface.onPointer, "function");
			assert.strictEqual(typeof surface.focus, "function");
			assert.strictEqual(typeof surface.unfocus, "function");
			assert.strictEqual(typeof surface.isFocused, "function");
		} finally {
			tui.stop();
		}
	});
});
