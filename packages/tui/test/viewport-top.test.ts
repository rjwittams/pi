import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FixedLines implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

async function flush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI viewportTop accessor", () => {
	it("returns 0 when total rendered lines fit within the terminal height", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLines(Array(10).fill("X")));
		tui.start();
		try {
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportTop, 0);
		} finally {
			tui.stop();
		}
	});

	it("returns the offset of the visible viewport when content exceeds terminal height", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLines(Array(100).fill("X")));
		tui.start();
		try {
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportTop, 100 - 24);
		} finally {
			tui.stop();
		}
	});
});
