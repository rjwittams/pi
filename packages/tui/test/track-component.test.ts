import assert from "node:assert";
import { describe, it } from "node:test";
import type { SurfaceRect } from "../src/index.ts";
import type { Component } from "../src/tui.ts";
import { Container, TUI } from "../src/tui.ts";
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

describe("TUI.trackComponent", () => {
	it("delivers a rect after the next render for a tracked component in the tree", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const target = new FixedLines(["one", "two", "three"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			const unregister = tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			// Expected: lines.length=3, terminal.rows=24, viewportTop=max(0, 3-24)=0,
			// bufferOffset=0, top=0, visTop=0, visBottom=3, rows=3.
			assert.strictEqual(calls.length, 1, "listener should fire once after first render");
			const rect = calls[0];
			assert.ok(rect, "rect should be defined for a visible component");
			assert.strictEqual(rect.row, 0);
			assert.strictEqual(rect.col, 0);
			assert.strictEqual(rect.rows, 3);
			assert.strictEqual(rect.cols, 80);
			assert.strictEqual(rect.totalRows, 3);
			unregister();
		} finally {
			tui.stop();
		}
	});

	it("does not re-fire when the rect is unchanged across renders", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const target = new FixedLines(["x"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1);
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1, "second render with identical layout should not re-fire");
		} finally {
			tui.stop();
		}
	});

	it("fires undefined when a tracked component is no longer in the tree", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const target = new FixedLines(["x"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1);
			assert.ok(calls[0] !== undefined);

			tui.removeChild(target);
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 2);
			assert.strictEqual(calls[1], undefined);
		} finally {
			tui.stop();
		}
	});

	it("descends into Container children to find nested tracked components", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const outer = new Container();
		const target = new FixedLines(["nested"]);
		outer.addChild(new FixedLines(["sib"]));
		outer.addChild(target);
		tui.addChild(outer);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1);
			const rect = calls[0];
			assert.ok(rect);
			assert.strictEqual(rect.row, 1, "nested target sits after 1-line sibling");
			assert.strictEqual(rect.rows, 1);
			assert.strictEqual(rect.totalRows, 1);
		} finally {
			tui.stop();
		}
	});

	it("unregister stops further listener fires", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const target = new FixedLines(["x"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			const unregister = tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1);
			unregister();
			tui.removeChild(target);
			await flush(tui, terminal);
			assert.strictEqual(calls.length, 1, "no further fires after unregister");
		} finally {
			tui.stop();
		}
	});
});
