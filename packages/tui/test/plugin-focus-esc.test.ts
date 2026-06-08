import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FocusableOverlay implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	handleInput(data: string): void {
		this.inputs.push(data);
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

describe("Pi-enforced Esc release for plugin focus", () => {
	it("Esc with plugin focus returns to preFocus and is not delivered to plugin", async () => {
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

			overlay.inputs.length = 0;
			terminal.sendInput("\x1b");
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
			assert.strictEqual(overlay.focused, false);
			assert.strictEqual(overlay.inputs.length, 0, "plugin must not see Esc that returned focus");
		} finally {
			tui.stop();
		}
	});

	it("Esc with non-plugin focus is delivered to focused component as before", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.start();
		try {
			terminal.sendInput("\x1b");
			await flush(tui, terminal);

			assert.deepStrictEqual(editor.inputs, ["\x1b"]);
		} finally {
			tui.stop();
		}
	});

	it("Esc with chained plugin focus returns to the root non-plugin component, not to a prior plugin focus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.setDefaultFocus(editor);

		const overlayA = new FocusableOverlay(["A"]);
		const overlayB = new FocusableOverlay(["B"]);
		tui.start();
		try {
			const handleA = tui.showOverlay(overlayA, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			const handleB = tui.showOverlay(overlayB, { width: 1, height: 1, anchor: "top-right", nonCapturing: true });
			await flush(tui, terminal);
			handleA.onPointer(() => {});
			handleB.onPointer(() => {});

			// Click A — first plugin focus entry; preFocus should be set to editor
			terminal.sendInput("\x1b[<0;1;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlayA.focused, true);

			// Click B — plugin-to-plugin switch; preFocus must remain editor, not overlayA
			terminal.sendInput("\x1b[<0;80;1M");
			await flush(tui, terminal);
			assert.strictEqual(overlayB.focused, true);
			assert.strictEqual(overlayA.focused, false);

			// Esc — must return to editor (the root pre-plugin focus), not to overlayA
			terminal.sendInput("\x1b");
			await flush(tui, terminal);
			assert.strictEqual(editor.focused, true, "Esc must return to root non-plugin focus");
			assert.strictEqual(overlayA.focused, false);
			assert.strictEqual(overlayB.focused, false);
		} finally {
			tui.stop();
		}
	});

	it("Esc released via Kitty CSI-u sequence (\\x1b[27u) also returns focus", async () => {
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

			overlay.inputs.length = 0;
			// Kitty keyboard protocol report for Esc: CSI 27 u
			terminal.sendInput("\x1b[27u");
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
			assert.strictEqual(overlay.focused, false);
			assert.strictEqual(overlay.inputs.length, 0);
		} finally {
			tui.stop();
		}
	});
});
