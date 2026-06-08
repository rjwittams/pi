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

describe("Hover delivery filter", () => {
	it("hover-motion (no buttons held) does NOT reach a default-subscription pointer listener", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, {
				width: 1,
				height: 1,
				anchor: "top-left",
				nonCapturing: true,
			});
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			// SGR motion-without-button: button code 35 (32 = motion, 3 = no button)
			terminal.sendInput("\x1b[<35;1;1M");

			assert.strictEqual(events.length, 0);
		} finally {
			tui.stop();
		}
	});

	it("hover-motion DOES reach a hover-opt-in subscription", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, {
				width: 1,
				height: 1,
				anchor: "top-left",
				nonCapturing: true,
			});
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev), { hover: true });

			terminal.sendInput("\x1b[<35;1;1M");

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "pointermove");
			assert.strictEqual(events[0]!.buttons, 0);
		} finally {
			tui.stop();
		}
	});

	it("drag-motion (button held) reaches default subscriptions (it's not hover)", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, {
				width: 1,
				height: 1,
				anchor: "top-left",
				nonCapturing: true,
			});
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			// SGR motion-with-left-button: button code 32 (32 = motion, 0 = left)
			terminal.sendInput("\x1b[<32;1;1M");

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "pointermove");
			assert.strictEqual(events[0]!.buttons, 1);
		} finally {
			tui.stop();
		}
	});

	it("hover events fall through to a lower hover-opt-in subscription if upper does not opt in", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const lowerOverlay = new FocusableOverlay(["L"]);
		const upperOverlay = new FocusableOverlay(["U"]);
		tui.start();
		try {
			const lower = tui.showOverlay(lowerOverlay, {
				width: 1,
				height: 1,
				anchor: "top-left",
				nonCapturing: true,
			});
			const upper = tui.showOverlay(upperOverlay, {
				width: 1,
				height: 1,
				anchor: "top-left",
				nonCapturing: true,
			});
			await flush(tui, terminal);
			const lowerEvents: PointerEvent[] = [];
			const upperEvents: PointerEvent[] = [];
			lower.onPointer((ev) => lowerEvents.push(ev), { hover: true });
			upper.onPointer((ev) => upperEvents.push(ev)); // no hover

			terminal.sendInput("\x1b[<35;1;1M");

			assert.strictEqual(upperEvents.length, 0, "upper has no hover-opt-in, must not receive");
			assert.strictEqual(lowerEvents.length, 1, "hover must fall through to lower hover-opt-in listener");
			assert.strictEqual(lowerEvents[0]!.type, "pointermove");
		} finally {
			tui.stop();
		}
	});
});
