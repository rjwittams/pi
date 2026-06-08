import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FocusableOverlay implements Component, Focusable {
	focused = false;
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
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

describe("Plugin focus auto-release", () => {
	it("clicking outside any subscribed overlay returns focus to preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});

			// Click into the overlay first to acquire plugin focus
			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			// Click far outside the overlay
			terminal.sendInput("\x1b[<0;40;20M");
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
			assert.strictEqual(overlay.focused, false);
		} finally {
			tui.stop();
		}
	});

	it("hiding a plugin-focused overlay returns focus to preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});
			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			handle.hide();
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});

	it("setHidden(true) on a plugin-focused overlay returns focus to preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});
			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			handle.setHidden(true);
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});

	it("hideOverlay() on a plugin-focused topmost overlay returns focus to preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});
			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			tui.hideOverlay();
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});
});
