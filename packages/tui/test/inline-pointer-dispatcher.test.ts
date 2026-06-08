import assert from "node:assert";
import { describe, it } from "node:test";
import type { PointerEvent } from "../src/pointer-events.ts";
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

describe("setInlinePointerDispatcher", () => {
	it("inline dispatcher is called when no overlay matches", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		tui.start();
		try {
			const seen: PointerEvent[] = [];
			tui.setInlinePointerDispatcher((event) => {
				seen.push(event);
				return false;
			});
			terminal.sendInput("\x1b[<0;5;5M");
			assert.strictEqual(seen.length, 1);
			assert.strictEqual(seen[0]!.type, "pointerdown");
			assert.strictEqual(seen[0]!.row, 4);
			assert.strictEqual(seen[0]!.col, 4);
		} finally {
			tui.stop();
		}
	});

	it("inline dispatcher is NOT called when an overlay consumed the event", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});

			const seen: PointerEvent[] = [];
			tui.setInlinePointerDispatcher((event) => {
				seen.push(event);
				return false;
			});
			terminal.sendInput("\x1b[<0;1;1M");
			assert.strictEqual(seen.length, 0);
		} finally {
			tui.stop();
		}
	});

	it("returning true from inline dispatcher prevents click-outside plugin-focus release", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["O"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});
			terminal.sendInput("\x1b[<0;1;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			tui.setInlinePointerDispatcher(() => true);
			terminal.sendInput("\x1b[<0;40;20M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, true, "inline consumed; plugin focus stays");
			assert.strictEqual(editor.focused, false);
		} finally {
			tui.stop();
		}
	});

	it("returning false from inline dispatcher allows click-outside plugin-focus release", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);
		const overlay = new FocusableOverlay(["O"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});
			terminal.sendInput("\x1b[<0;1;1M");
			await flush(tui, terminal);

			tui.setInlinePointerDispatcher(() => false);
			terminal.sendInput("\x1b[<0;40;20M");
			await flush(tui, terminal);
			assert.strictEqual(overlay.focused, false);
			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});
});
