import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { HStack } from "../src/components/h-stack.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { SurfaceGeometry } from "../src/surface.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CursorTerminal extends VirtualTerminal {
	initialRow = 0;
	answerCursorQuery = true;
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
		if (data === "\x1b[6n" && this.answerCursorQuery) this.sendInput(`\x1b[${this.initialRow + 1};1R`);
	}
}

class Lines implements Component {
	lines: string[];
	renders = 0;
	constructor(lines = ["surface"]) {
		this.lines = lines;
	}
	render(): string[] {
		this.renders++;
		return this.lines;
	}
	invalidate(): void {}
}

describe("committed surface geometry", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`${Renderer.name}: publishes padded nested geometry after writes, without rerendering`, async () => {
			const terminal = new CursorTerminal(30, 12);
			const tui = new Renderer(terminal);
			const surface = new Lines();
			const box = new Box(2, 1);
			box.addChild(new MouseRegion(surface, () => undefined));
			tui.addChild(box);
			const handle = tui.trackSurface(surface);
			const seen: (SurfaceGeometry | undefined)[] = [];
			handle.onGeometryChange((geometry) => {
				if (geometry) assert.ok(terminal.writes.some((write) => write.includes("surface")));
				seen.push(geometry);
			});
			assert.deepEqual(seen, [undefined]);
			tui.start();
			try {
				tui.renderNow();
				await terminal.flush();
				assert.deepEqual(handle.getGeometry(), {
					bounds: { x: 2, y: 1, width: 26, height: 1 },
					clip: { x: 2, y: 1, width: 26, height: 1 },
					contentOffset: 0,
				});
				assert.equal(terminal.getViewport()[1].indexOf("surface"), 2);
				assert.equal(surface.renders, 1);
				tui.renderNow();
				assert.equal(seen.length, 2);
				const copy = handle.getGeometry()!;
				copy.bounds.x = 999;
				assert.equal(handle.getGeometry()!.bounds.x, 2);
				box.removeChild(box.children[0]);
				tui.renderNow();
				assert.equal(handle.getGeometry(), undefined);
				handle.dispose();
				handle.dispose();
				const count = seen.length;
				box.addChild(surface);
				tui.renderNow();
				assert.equal(seen.length, count);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: tracks overlay visibility and ends subscriptions on stop`, () => {
			const terminal = new CursorTerminal(30, 12);
			const tui = new Renderer(terminal);
			const surface = new Lines();
			const handle = tui.trackSurface(surface);
			const seen: (SurfaceGeometry | undefined)[] = [];
			handle.onGeometryChange((geometry) => seen.push(geometry));
			tui.start();
			try {
				const overlay = tui.showOverlay(surface, { row: 3, col: 4, width: 10 });
				tui.renderNow();
				assert.deepEqual(handle.getGeometry()!.bounds, { x: 4, y: 3, width: 10, height: 1 });
				overlay.setHidden(true);
				tui.renderNow();
				assert.equal(handle.getGeometry(), undefined);
				overlay.setHidden(false);
				tui.renderNow();
				assert.ok(handle.getGeometry());
				tui.stop();
				assert.equal(handle.getGeometry(), undefined);
				const count = seen.length;
				tui.start();
				tui.renderNow();
				assert.equal(seen.length, count);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: publishes sibling snapshots before callbacks and defers reentrant renders`, () => {
			const terminal = new CursorTerminal(30, 12);
			const tui = new Renderer(terminal);
			const first = new Lines();
			const second = new Lines();
			tui.addChild(first);
			tui.addChild(second);
			const a = tui.trackSurface(first);
			const b = tui.trackSurface(second);
			const observed: number[] = [];
			a.onGeometryChange((geometry) => {
				if (!geometry) return;
				observed.push(b.getGeometry()!.bounds.y);
				tui.renderNow();
				throw new Error("consumer failure");
			});
			let deliveries = 0;
			b.onGeometryChange(() => deliveries++);
			tui.start();
			try {
				tui.renderNow();
				assert.deepEqual(observed, [1]);
				assert.equal(deliveries, 2);
				assert.equal(first.renders, 1);
				first.lines = ["one", "two"];
				tui.renderNow();
				assert.deepEqual(observed, [1, 2]);
				assert.equal(deliveries, 3);
				tui.removeChild(second);
				tui.renderNow();
				assert.equal(b.getGeometry(), undefined);
				tui.addChild(second);
				tui.renderNow();
				assert.equal(b.getGeometry()!.bounds.y, 2);
			} finally {
				tui.stop();
			}
		});
	}

	it("fullscreen distinguishes clipping at both edges and preserves logical origin", () => {
		const terminal = new CursorTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		const surface = new Lines(Array.from({ length: 20 }, (_, i) => `row ${i}`));
		const container = new Container();
		container.addChild(surface);
		const scroll = new ScrollView(container);
		tui.setLayoutRoot(new VStack([{ component: scroll, basis: 6, shrink: 0 }, new Lines(["dock"])]));
		const handle = tui.trackSurface(surface);
		tui.start();
		try {
			tui.renderNow();
			scroll.scrollTo(5);
			tui.renderNow();
			assert.deepEqual(handle.getGeometry(), {
				bounds: { x: 0, y: -5, width: 30, height: 20 },
				clip: { x: 0, y: 0, width: 30, height: 6 },
				contentOffset: 0,
			});
		} finally {
			tui.stop();
		}
	});

	it("fullscreen reports cursor-scrolled leaf content offset", () => {
		const terminal = new CursorTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		const surface = new Lines(["0", "1", "2", `3${CURSOR_MARKER}`]);
		tui.setLayoutRoot(new VStack([{ component: surface, basis: 2, shrink: 0 }]));
		const handle = tui.trackSurface(surface);
		tui.start();
		try {
			tui.renderNow();
			assert.equal(handle.getGeometry()!.contentOffset, 2);
			assert.equal(handle.getGeometry()!.bounds.height, 2);
		} finally {
			tui.stop();
		}
	});

	it("regular mode anchors geometry to a nonzero physical startup row and follows scrolling", async () => {
		const terminal = new CursorTerminal(30, 12);
		terminal.initialRow = 4;
		terminal.write("\x1b[5;1H");
		await terminal.flush();
		const tui = new TuiMainScreen(terminal);
		const surface = new Lines();
		tui.addChild(surface);
		const handle = tui.trackSurface(surface);
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			assert.equal(handle.getGeometry()!.bounds.y, 4);
			assert.match(terminal.getViewport()[4], /surface/);
			surface.lines = Array.from({ length: 10 }, (_, i) => `row ${i}`);
			tui.renderNow();
			await terminal.flush();
			assert.equal(handle.getGeometry()!.bounds.y, 2);
			assert.match(terminal.getViewport()[2], /row 0/);
			terminal.resize(31, 12);
			tui.renderNow();
			assert.equal(handle.getGeometry()!.bounds.y, 0);
		} finally {
			tui.stop();
		}
	});

	it("regular mode does not invent screen coordinates before a cursor report or clearing render", () => {
		const terminal = new CursorTerminal(30, 12);
		terminal.answerCursorQuery = false;
		const tui = new TuiMainScreen(terminal);
		const surface = new Lines();
		tui.addChild(surface);
		const handle = tui.trackSurface(surface);
		tui.start();
		try {
			tui.renderNow();
			assert.equal(handle.getGeometry(), undefined);
			terminal.sendInput("\x1b[5;1R");
			tui.renderNow();
			assert.equal(handle.getGeometry()!.bounds.y, 4);
		} finally {
			tui.stop();
		}
	});

	it("horizontal layout reports distinct sibling bounds", () => {
		const terminal = new CursorTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		const left = new Lines();
		const right = new Lines();
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10 },
				{ component: right, basis: 20 },
			]),
		);
		const a = tui.trackSurface(left);
		const b = tui.trackSurface(right);
		tui.start();
		try {
			tui.renderNow();
			assert.equal(a.getGeometry()!.bounds.width, 10);
			assert.equal(b.getGeometry()!.bounds.x, 10);
			assert.equal(b.getGeometry()!.bounds.width, 20);
		} finally {
			tui.stop();
		}
	});
});
