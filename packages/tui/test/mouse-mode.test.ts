import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI mouse mode lifecycle", () => {
	it("enables mouse mode on first acquire and writes ?1002h + ?1006h", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		const release = tui.acquireMouseMode();

		assert.ok(written.some((d) => d.includes("\x1b[?1002h")));
		assert.ok(written.some((d) => d.includes("\x1b[?1006h")));

		release();
	});

	it("does not write enable bytes again on a second concurrent acquire", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const release1 = tui.acquireMouseMode();

		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		const release2 = tui.acquireMouseMode();

		assert.ok(!written.some((d) => d.includes("\x1b[?1002h")));

		release1();
		release2();
	});

	it("only disables mouse mode after the last release", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const release1 = tui.acquireMouseMode();
		const release2 = tui.acquireMouseMode();

		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		release1();
		assert.ok(!written.some((d) => d.includes("\x1b[?1002l")));

		release2();
		assert.ok(written.some((d) => d.includes("\x1b[?1002l")));
		assert.ok(written.some((d) => d.includes("\x1b[?1006l")));
	});

	it("releasing the same handle twice is a no-op", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const release = tui.acquireMouseMode();
		release();

		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		release();
		assert.ok(!written.some((d) => d.includes("\x1b[?1002l")));
	});

	it("disables mouse mode in stop() when refcount > 0", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const _release = tui.acquireMouseMode();

		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		tui.stop();

		assert.ok(written.some((d) => d.includes("\x1b[?1002l")));
		assert.ok(written.some((d) => d.includes("\x1b[?1006l")));
	});

	it("release after stop() does not crash and does not write spurious bytes", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const release = tui.acquireMouseMode();
		tui.stop();

		const written: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			written.push(data);
			origWrite(data);
		};

		release();
		assert.ok(!written.some((d) => d.includes("\x1b[?1002l")));
	});
});
