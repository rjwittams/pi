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

describe("Click-to-focus on overlay", () => {
	it("pointerdown inside an overlay's rect sets focus to that overlay", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			handle.onPointer(() => {});

			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, false);
			assert.strictEqual(overlay.focused, true);
		} finally {
			tui.stop();
		}
	});

	it("the focusing pointerdown is also delivered to the overlay's onPointer listener", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			terminal.sendInput("\x1b[<0;3;1M");

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "pointerdown");
		} finally {
			tui.stop();
		}
	});

	it("pointerdown on a non-subscribed overlay does not change focus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new FocusableOverlay(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		const overlay = new FocusableOverlay(["OVERLAY"]);
		tui.start();
		try {
			// No onPointer subscription — overlay is not a click-focus target
			tui.showOverlay(overlay, { width: 7, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);

			terminal.sendInput("\x1b[<0;3;1M");
			await flush(tui, terminal);

			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});
});
