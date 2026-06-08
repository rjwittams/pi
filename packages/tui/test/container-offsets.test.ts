import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { Container } from "../src/tui.ts";

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

describe("Container per-child offset tracking", () => {
	it("records start line and line count for each child in the most recent render", () => {
		const container = new Container();
		const a = new FixedLines(["A0", "A1"]);
		const b = new FixedLines(["B0"]);
		const c = new FixedLines(["C0", "C1", "C2"]);
		container.addChild(a);
		container.addChild(b);
		container.addChild(c);

		const lines = container.render(80);
		assert.deepStrictEqual(lines, ["A0", "A1", "B0", "C0", "C1", "C2"]);

		assert.deepStrictEqual(container.getChildOffset(a), { startLine: 0, lineCount: 2 });
		assert.deepStrictEqual(container.getChildOffset(b), { startLine: 2, lineCount: 1 });
		assert.deepStrictEqual(container.getChildOffset(c), { startLine: 3, lineCount: 3 });
	});

	it("returns undefined for a child not present in the most recent render", () => {
		const container = new Container();
		const a = new FixedLines(["A0"]);
		const orphan = new FixedLines(["X"]);
		container.addChild(a);
		container.render(80);
		assert.strictEqual(container.getChildOffset(orphan), undefined);
	});

	it("clears stale entries when render runs again with a different child set", () => {
		const container = new Container();
		const a = new FixedLines(["A0"]);
		const b = new FixedLines(["B0"]);
		container.addChild(a);
		container.addChild(b);
		container.render(80);
		container.removeChild(a);
		container.render(80);

		assert.strictEqual(container.getChildOffset(a), undefined);
		assert.deepStrictEqual(container.getChildOffset(b), { startLine: 0, lineCount: 1 });
	});

	it("clear() removes all childOffsets entries", () => {
		const container = new Container();
		const a = new FixedLines(["A0", "A1"]);
		const b = new FixedLines(["B0"]);
		container.addChild(a);
		container.addChild(b);
		container.render(80);

		assert.deepStrictEqual(container.getChildOffset(a), { startLine: 0, lineCount: 2 });
		container.clear();
		assert.strictEqual(container.getChildOffset(a), undefined);
		assert.strictEqual(container.getChildOffset(b), undefined);
	});

	it("removeChild() removes that child's offset entry", () => {
		const container = new Container();
		const a = new FixedLines(["A0", "A1"]);
		const b = new FixedLines(["B0"]);
		container.addChild(a);
		container.addChild(b);
		container.render(80);

		assert.deepStrictEqual(container.getChildOffset(a), { startLine: 0, lineCount: 2 });
		container.removeChild(a);
		assert.strictEqual(container.getChildOffset(a), undefined, "removed child's entry must be cleared immediately");
		// b's entry is still from the most recent render — it's still a child.
		assert.deepStrictEqual(container.getChildOffset(b), { startLine: 2, lineCount: 1 });
	});

	it("forEachChild visits each rendered child with its startLine and lineCount", () => {
		const container = new Container();
		const a = new FixedLines(["A0", "A1"]);
		const b = new FixedLines(["B0"]);
		const c = new FixedLines(["C0", "C1", "C2"]);
		container.addChild(a);
		container.addChild(b);
		container.addChild(c);
		container.render(80);

		const visits: Array<{ child: unknown; startLine: number; lineCount: number }> = [];
		container.forEachChild((child, startLine, lineCount) => {
			visits.push({ child, startLine, lineCount });
		});
		assert.deepStrictEqual(visits, [
			{ child: a, startLine: 0, lineCount: 2 },
			{ child: b, startLine: 2, lineCount: 1 },
			{ child: c, startLine: 3, lineCount: 3 },
		]);
	});

	it("forEachChild skips children with no recorded offset", () => {
		const container = new Container();
		const a = new FixedLines(["A0"]);
		container.addChild(a);
		// No render() — childOffsets is empty.

		const visits: unknown[] = [];
		container.forEachChild((child) => {
			visits.push(child);
		});
		assert.deepStrictEqual(visits, []);
	});

	it("forEachChild is a no-op on an empty Container", () => {
		const container = new Container();
		let called = false;
		container.forEachChild(() => {
			called = true;
		});
		assert.strictEqual(called, false);
	});
});
