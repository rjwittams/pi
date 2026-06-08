import assert from "node:assert";
import { describe, it } from "node:test";
import type { PointerEvent } from "../src/pointer-events.ts";
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

describe("Wheel routing", () => {
	it("wheel events do not reach a default-subscription pointer listener", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			terminal.sendInput("\x1b[<64;1;1M"); // wheel up

			assert.strictEqual(events.length, 0);
		} finally {
			tui.stop();
		}
	});

	it("wheel events reach a wheel-opt-in subscription", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev), { wheel: true });

			terminal.sendInput("\x1b[<64;1;1M");

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "wheel");
		} finally {
			tui.stop();
		}
	});

	it("non-wheel events still reach default-subscription listeners", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const overlay = new FocusableOverlay(["X"]);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay, { width: 1, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);
			const events: PointerEvent[] = [];
			handle.onPointer((ev) => events.push(ev));

			terminal.sendInput("\x1b[<0;1;1M"); // pointerdown

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.type, "pointerdown");
		} finally {
			tui.stop();
		}
	});

	it("wheel event over a non-wheel-subscribed overlay falls through to a wheel-subscribed overlay below", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new EmptyContent());
		const lowerOverlay = new FocusableOverlay(["LOWER"]);
		const upperOverlay = new FocusableOverlay(["UPPER"]);
		tui.start();
		try {
			const lower = tui.showOverlay(lowerOverlay, { width: 5, height: 1, anchor: "top-left", nonCapturing: true });
			const upper = tui.showOverlay(upperOverlay, { width: 5, height: 1, anchor: "top-left", nonCapturing: true });
			await flush(tui, terminal);

			const lowerEvents: PointerEvent[] = [];
			const upperEvents: PointerEvent[] = [];
			lower.onPointer((ev) => lowerEvents.push(ev), { wheel: true });
			upper.onPointer((ev) => upperEvents.push(ev)); // no wheel

			terminal.sendInput("\x1b[<64;1;1M"); // wheel up

			assert.strictEqual(upperEvents.length, 0, "upper has no wheel-opt-in, must not receive");
			assert.strictEqual(lowerEvents.length, 1, "wheel must fall through to lower wheel-opt-in listener");
			assert.strictEqual(lowerEvents[0]!.type, "wheel");
		} finally {
			tui.stop();
		}
	});
});
