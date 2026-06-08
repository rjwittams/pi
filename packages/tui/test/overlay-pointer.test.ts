import assert from "node:assert";
import { describe, it } from "node:test";
import type { PointerEvent } from "../src/pointer-events.ts";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
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

describe("OverlayHandle.onPointer", () => {
	it("delivers structured events when the pointer lands inside the overlay rect", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA", "BBBBB", "CCCCC"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 5, height: 3, anchor: "top-left" });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			// SGR press at row=1, col=2 (1-based 3,2 → 0-based 2,1)
			terminal.sendInput("\x1b[<0;3;2M");

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "pointerdown");
			assert.strictEqual(events[0]!.row, 1);
			assert.strictEqual(events[0]!.col, 2);
		} finally {
			tui.stop();
		}
	});

	it("does not deliver events that land outside the overlay rect", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 5, height: 1, anchor: "top-left" });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			// Press far outside the 5x1 overlay at top-left
			terminal.sendInput("\x1b[<0;40;20M");

			assert.strictEqual(events.length, 0);
		} finally {
			tui.stop();
		}
	});

	it("auto-releases the listener when the overlay is hidden", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 5, height: 1, anchor: "top-left" });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			handle.hide();
			await flush(tui, terminal);

			terminal.sendInput("\x1b[<0;3;1M");
			assert.strictEqual(events.length, 0);
		} finally {
			tui.stop();
		}
	});

	it("acquires mouse mode on first onPointer and releases on last unsubscribe", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA"]);
		tui.start();
		try {
			const written: string[] = [];
			const origWrite = terminal.write.bind(terminal);
			terminal.write = (data: string) => {
				written.push(data);
				origWrite(data);
			};

			const handle = tui.showOverlay(overlay, { width: 5, height: 1, anchor: "top-left" });
			await flush(tui, terminal);

			assert.ok(!written.some((d) => d.includes("\x1b[?1003h")));

			const off = handle.onPointer(() => {});
			assert.ok(written.some((d) => d.includes("\x1b[?1003h")));

			off();
			assert.ok(written.some((d) => d.includes("\x1b[?1003l")));
		} finally {
			tui.stop();
		}
	});

	it("a listener that throws does not break delivery to other listeners", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 5, height: 1, anchor: "top-left" });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer(() => {
				throw new Error("first listener boom");
			});
			handle.onPointer((ev) => events.push(ev));

			terminal.sendInput("\x1b[<0;3;1M");

			assert.strictEqual(events.length, 1, "second listener must still be invoked");
			assert.strictEqual(events[0]!.type, "pointerdown");
		} finally {
			tui.stop();
		}
	});

	it("calling the unsubscribe function twice is safe", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new StaticOverlay(["AAAAA"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 5, height: 1, anchor: "top-left" });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			const off = handle.onPointer((ev) => events.push(ev));
			off();
			off();

			terminal.sendInput("\x1b[<0;3;1M");
			assert.strictEqual(events.length, 0);
		} finally {
			tui.stop();
		}
	});
});
