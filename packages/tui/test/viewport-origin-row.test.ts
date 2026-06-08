import assert from "node:assert";
import { describe, it } from "node:test";
import type { SurfaceRect } from "../src/index.ts";
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
	tui.requestRender();
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("Terminal.onInitialCursorRow", () => {
	it("VirtualTerminal fires the registered handler with the simulated row when start() is called", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(14);
		const calls: number[] = [];
		terminal.onInitialCursorRow((row) => calls.push(row));
		// start() must invoke the handler with the simulated value.
		terminal.start(
			() => {},
			() => {},
		);
		// Allow the nextTick callback to fire.
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.deepStrictEqual(calls, [14]);
		terminal.stop();
	});
});

describe("TUI.viewportOriginRow", () => {
	it("is 0 when the terminal reports cursor at row 0", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(0);
		const tui = new TUI(terminal);
		tui.start();
		try {
			await new Promise<void>((resolve) => process.nextTick(resolve));
			assert.strictEqual(tui.viewportOriginRow, 0);
		} finally {
			tui.stop();
		}
	});

	it("matches the row reported by the terminal", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(14);
		const tui = new TUI(terminal);
		tui.start();
		try {
			await new Promise<void>((resolve) => process.nextTick(resolve));
			assert.strictEqual(tui.viewportOriginRow, 14);
		} finally {
			tui.stop();
		}
	});
});

describe("deliverTrackedRect with viewportOriginRow", () => {
	it("offsets rect.row by viewportOriginRow when the surface fits in the viewport", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(5);
		const tui = new TUI(terminal);
		const target = new FixedLines(["a", "b", "c"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			// bufferOffset=0, viewportTop=0, viewportOriginRow=5 → rect.row=5.
			// rect.rows still 3 (the surface's line count), unchanged.
			const rect = calls[calls.length - 1];
			assert.ok(rect, "rect should be defined");
			assert.strictEqual(rect.row, 5, "rect.row should equal viewportOriginRow");
			assert.strictEqual(rect.rows, 3);
		} finally {
			tui.stop();
		}
	});

	it("clamps to terminal.rows when viewportOriginRow + lineCount overflows the viewport", async () => {
		const terminal = new VirtualTerminal(80, 10);
		terminal.setSimulatedInitialCursorRow(8);
		const tui = new TUI(terminal);
		// 5-line surface starting at viewportOriginRow=8 in a 10-row terminal.
		// After fullRender(false): would-be final row = 8 + 5 - 1 = 12.
		// Scrolls = 12 - 9 = 3. viewportOriginRow drops to max(0, 8-3) = 5.
		// All 5 lines now sit at terminal rows 5-9 (fully visible).
		const target = new FixedLines(["a", "b", "c", "d", "e"]);
		tui.addChild(target);
		tui.start();
		try {
			const calls: Array<SurfaceRect | undefined> = [];
			tui.trackComponent(target, (rect) => calls.push(rect));
			await flush(tui, terminal);
			const rect = calls[calls.length - 1];
			assert.ok(rect, "rect should be defined");
			assert.strictEqual(rect.row, 5);
			assert.strictEqual(rect.rows, 5);
			assert.strictEqual(rect.totalRows, 5);
		} finally {
			tui.stop();
		}
	});
});

describe("restoreHardwareCursorAfterRawWrite with viewportOriginRow", () => {
	it("emits CUP at terminal row offset by viewportOriginRow", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(7);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLines(["row0", "row1", "row2"]));
		tui.start();
		try {
			await flush(tui, terminal);
			// Establish a known logical cursor: write some lines to drive
			// hardwareCursorRow forward. After the first render with 3 lines,
			// hardwareCursorRow = 2 (logical), previousViewportTop = 0.
			// viewportOriginRow = 7, so writeRaw's CUP target row should be
			// 2 - 0 + 7 = 9 (0-indexed) → "\x1b[10;..H" (1-indexed).
			const writes: string[] = [];
			const origWrite = terminal.write.bind(terminal);
			(terminal as { write: (data: string) => void }).write = (data) => {
				writes.push(data);
				origWrite(data);
			};
			tui.writeRaw("");
			// writeRaw triggers restoreHardwareCursorAfterRawWrite, which emits a CUP.
			const cupMatches = writes
				.flatMap((w) => Array.from(w.matchAll(/\x1b\[(\d+);(\d+)H/g)))
				.map((m) => ({ row: parseInt(m[1], 10), col: parseInt(m[2], 10) }));
			assert.ok(cupMatches.length > 0, "writeRaw should restore the cursor via CUP");
			const last = cupMatches[cupMatches.length - 1];
			assert.strictEqual(last.row, 10, "1-indexed terminal row = 9 + 1 = 10");
		} finally {
			tui.stop();
		}
	});
});

describe("viewportOriginRow reset on fullRender(true)", () => {
	it("resets to 0 when the terminal width changes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(7);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLines(["a"]));
		tui.start();
		try {
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportOriginRow, 7);
			// Width change triggers fullRender(true).
			terminal.resize(120, 24);
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportOriginRow, 0);
		} finally {
			tui.stop();
		}
	});
});

describe("viewportOriginRow decrement on fullRender(false) scroll", () => {
	it("decreases by exactly the scroll count when the first render overflows the viewport", async () => {
		const terminal = new VirtualTerminal(80, 10);
		terminal.setSimulatedInitialCursorRow(5);
		const tui = new TUI(terminal);
		// 8 lines + start at row 5 in a 10-row terminal:
		// would-be final row = 5 + 8 - 1 = 12. Scrolls = 12 - 9 = 3.
		// New viewportOriginRow = max(0, 5 - 3) = 2.
		const lines = Array.from({ length: 8 }, (_, i) => `line${i}`);
		tui.addChild(new FixedLines(lines));
		tui.start();
		try {
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportOriginRow, 2);
		} finally {
			tui.stop();
		}
	});

	it("stays put when content fits without scrolling", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(5);
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 8 }, (_, i) => `line${i}`);
		tui.addChild(new FixedLines(lines));
		tui.start();
		try {
			await flush(tui, terminal);
			// 5 + 8 - 1 = 12 < 23, no scroll, viewportOriginRow stays at 5.
			assert.strictEqual(tui.viewportOriginRow, 5);
		} finally {
			tui.stop();
		}
	});
});

describe("viewportOriginRow decrement on differential render scroll", () => {
	it("decreases when a follow-up render extends the buffer past the terminal bottom", async () => {
		const terminal = new VirtualTerminal(80, 10);
		terminal.setSimulatedInitialCursorRow(3);
		const tui = new TUI(terminal);
		const target = new FixedLines(["a", "b"]);
		tui.addChild(target);
		tui.start();
		try {
			await flush(tui, terminal);
			// After first render: 2 lines start at row 3, final row 4. No scroll.
			assert.strictEqual(tui.viewportOriginRow, 3);
			// Replace target with 9-line content. previousLines.length=2,
			// newLines.length=9. Differential write goes from row 3 onward.
			// renderEnd = 8 (last new line). Final unclamped row =
			// 8 - 0 + 3 = 11. Terminal max row = 9. Scrolls = 11 - 9 = 2.
			// New viewportOriginRow = max(0, 3 - 2) = 1.
			tui.removeChild(target);
			tui.addChild(new FixedLines(["a", "b", "c", "d", "e", "f", "g", "h", "i"]));
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportOriginRow, 1);
		} finally {
			tui.stop();
		}
	});

	it("stays put when the differential render does not scroll", async () => {
		const terminal = new VirtualTerminal(80, 24);
		terminal.setSimulatedInitialCursorRow(3);
		const tui = new TUI(terminal);
		const target = new FixedLines(["a", "b"]);
		tui.addChild(target);
		tui.start();
		try {
			await flush(tui, terminal);
			assert.strictEqual(tui.viewportOriginRow, 3);
			tui.removeChild(target);
			tui.addChild(new FixedLines(["a", "b", "c", "d"]));
			await flush(tui, terminal);
			// Final unclamped row = 3 + 4 - 1 = 6 < 23, no scroll.
			assert.strictEqual(tui.viewportOriginRow, 3);
		} finally {
			tui.stop();
		}
	});
});
