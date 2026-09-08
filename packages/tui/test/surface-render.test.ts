import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { SurfaceRenderContext } from "../src/surface.ts";
import {
	deleteKittyImage,
	encodeKitty,
	getCellDimensions,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Generated 2x2 black/white RGB checkerboard PNG; no producer or external process.
const CHECKERBOARD =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4//8/AwQAWQAp5AX7XiD3SwAAAABJRU5ErkJggg==";
const EXTERNAL_IMAGE = encodeKitty(CHECKERBOARD, { imageId: 9001, columns: 2, rows: 1, moveCursor: false });
const CLEANUP = deleteKittyImage(9001);

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	throwOn: string | undefined;
	startupRow = 0;
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
		if (data === this.throwOn) throw new Error("terminal write failure");
		if (data === "\x1b[6n") this.sendInput(`\x1b[${this.startupRow + 1};1R`);
	}
	override stop(): void {
		this.writes.push("TERMINAL_STOP");
		super.stop();
	}
}

class Panel implements Component {
	lines = ["body", `edit${CURSOR_MARKER}`];
	beforeRender: (() => void) | undefined;
	render(): string[] {
		this.beforeRender?.();
		return this.lines;
	}
	invalidate(): void {}
}

describe("surface external drawing", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`${Renderer.name}: text and ready surface graphics share one synchronized update`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			tui.trackSurface(panel).onRender((frame) => {
				if (!frame.disposed) frame.write(EXTERNAL_IMAGE);
			});
			tui.start();
			try {
				terminal.writes = [];
				tui.renderNow();
				const output = terminal.writes.join("");
				assert.equal(output.split("\x1b[?2026h").length - 1, 1);
				assert.equal(output.split("\x1b[?2026l").length - 1, 1);
				assert.ok(output.indexOf("body") < output.indexOf(EXTERNAL_IMAGE));
				assert.ok(output.indexOf(EXTERNAL_IMAGE) < output.indexOf("\x1b[?2026l"));
			} finally {
				tui.stop();
			}
		});
		it(`${Renderer.name}: cell-size reports invalidate graphics even when cell bounds do not change`, () => {
			const previous = getCellDimensions();
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const frames: SurfaceRenderContext[] = [];
			handle.onRender((frame) => frames.push(frame));
			tui.start();
			try {
				tui.renderNow();
				terminal.sendInput("\x1b[6;20;10t");
				tui.renderNow();
				assert.equal(frames[1].graphicsInvalidation, "images");
				assert.deepEqual(frames[1].geometry, frames[0].geometry);
				assert.ok(frames[1].revision > frames[0].revision);
			} finally {
				tui.stop();
				setCellDimensions(previous);
			}
		});

		it(`${Renderer.name}: a disposal callback cannot write into a restarted renderer`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const accepted: boolean[] = [];
			handle.onRender((frame) => {
				if (!frame.disposed) return;
				tui.stop();
				tui.start();
				accepted.push(frame.write(EXTERNAL_IMAGE));
			});
			tui.start();
			try {
				tui.renderNow();
				handle.dispose();
				assert.deepEqual(accepted, [false]);
				assert.ok(!terminal.writes.includes(EXTERNAL_IMAGE));
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: orders graphics after text and preserves the cursor through differential renders`, async () => {
			const terminal = new RecordingTerminal(30, 12);
			if (Renderer === TuiMainScreen) {
				terminal.startupRow = 3;
				terminal.write("\x1b[4;1H");
				await terminal.flush();
			}
			const tui = new Renderer(terminal, true);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const accepted: boolean[] = [];
			handle.onRender((frame) => {
				if (!frame.disposed) accepted.push(frame.write(`\x1b[10;20H${EXTERNAL_IMAGE}`));
			});
			tui.start();
			try {
				tui.renderNow();
				await terminal.flush();
				assert.deepEqual(terminal.getCursorPosition(), { x: 4, y: terminal.startupRow + 1 });
				assert.deepEqual(accepted, [true]);
				assert.ok(
					terminal.writes.findIndex((write) => write.includes(EXTERNAL_IMAGE)) >
						terminal.writes.findIndex((write) => write.includes("body")),
				);
				panel.lines[0] = "changed";
				tui.renderNow();
				await terminal.flush();
				assert.equal(terminal.getViewport()[terminal.startupRow].trimEnd(), "changed");
				assert.deepEqual(terminal.getCursorPosition(), { x: 4, y: terminal.startupRow + 1 });
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: idle frames retain revision; forced redraw invalidates unchanged geometry`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const frames: SurfaceRenderContext[] = [];
			handle.onRender((frame) => frames.push(frame));
			tui.start();
			try {
				tui.renderNow();
				tui.renderNow();
				tui.renderNow(true);
				assert.deepEqual(
					frames.map((frame) => frame.graphicsInvalidation),
					["images", "none", "images"],
				);
				assert.equal(frames[0].revision, frames[1].revision);
				assert.ok(frames[2].revision > frames[1].revision);
				assert.deepEqual(frames[0].geometry, frames[2].geometry);
				assert.equal(frames[2].write(EXTERNAL_IMAGE), false);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: an asynchronous producer requests a frame without retaining a usable writer`, async () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			let ready = false;
			const frames: SurfaceRenderContext[] = [];
			handle.onRender((frame) => {
				frames.push(frame);
				if (ready && !frame.disposed) frame.write(EXTERNAL_IMAGE);
			});
			tui.start();
			try {
				tui.renderNow();
				await Promise.resolve();
				assert.equal(frames[0].write(EXTERNAL_IMAGE), false);
				ready = true;
				handle.requestRender();
				await terminal.waitForRender();
				assert.ok(terminal.writes.includes(EXTERNAL_IMAGE));
				assert.equal(frames.at(-1)!.revision, frames[0].revision);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: disappearance allows placement cleanup after the deleting render`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const frames: SurfaceRenderContext[] = [];
			handle.onRender((frame) => {
				frames.push(frame);
				if (!frame.geometry) frame.write(CLEANUP);
			});
			tui.start();
			try {
				tui.renderNow();
				const offset = terminal.writes.length;
				tui.removeChild(panel);
				tui.renderNow();
				const writes = terminal.writes.slice(offset);
				assert.equal(frames.at(-1)!.geometry, undefined);
				assert.equal(frames.at(-1)!.disposed, false);
				assert.equal(frames.at(-1)!.graphicsInvalidation, "placements");
				assert.ok(writes.indexOf(CLEANUP) > writes.findIndex((write) => write.includes("\x1b[2K")));
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: disposing inside a callback revokes its writer and delivers cleanup once`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const accepted: boolean[] = [];
			handle.onRender((frame) => {
				if (frame.disposed) {
					accepted.push(frame.write(CLEANUP));
					return;
				}
				accepted.push(frame.write(EXTERNAL_IMAGE));
				handle.dispose();
				accepted.push(frame.write(EXTERNAL_IMAGE));
			});
			tui.start();
			try {
				tui.renderNow();
				handle.dispose();
				assert.deepEqual(accepted, [true, true, false]);
				assert.equal(terminal.writes.filter((write) => write === CLEANUP).length, 1);
				assert.ok(terminal.writes.indexOf(CLEANUP) > terminal.writes.indexOf(EXTERNAL_IMAGE));
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: disposal during component rendering defers cleanup until after text output`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			handle.onRender((frame) => {
				if (frame.disposed) frame.write(CLEANUP);
			});
			tui.start();
			try {
				tui.renderNow();
				const offset = terminal.writes.length;
				panel.lines[0] = "replacement";
				panel.beforeRender = () => handle.dispose();
				tui.renderNow();
				const writes = terminal.writes.slice(offset);
				assert.ok(writes.indexOf(CLEANUP) > writes.findIndex((write) => write.includes("replacement")));
				assert.equal(writes.filter((write) => write === CLEANUP).length, 1);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: stop cleans up before releasing the terminal and rejects old writers`, () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const frames: SurfaceRenderContext[] = [];
			handle.onRender((frame) => {
				frames.push(frame);
				if (frame.disposed) frame.write(CLEANUP);
			});
			tui.start();
			tui.renderNow();
			tui.stop();
			assert.ok(terminal.writes.indexOf(CLEANUP) < terminal.writes.indexOf("TERMINAL_STOP"));
			assert.equal(frames.filter((frame) => frame.disposed).length, 1);
			assert.equal(frames.at(-1)!.write(EXTERNAL_IMAGE), false);
		});

		it(`${Renderer.name}: restores cursor state after a write error and continues other consumers`, async () => {
			const terminal = new RecordingTerminal(30, 12);
			const tui = new Renderer(terminal, true);
			const panel = new Panel();
			tui.addChild(panel);
			const handle = tui.trackSurface(panel);
			const failing = `\x1b[10;20H${EXTERNAL_IMAGE}`;
			terminal.throwOn = failing;
			handle.onRender((frame) => {
				if (!frame.disposed) frame.write(failing);
			});
			handle.onRender((frame) => {
				if (!frame.disposed) frame.write(CLEANUP);
			});
			tui.start();
			try {
				tui.renderNow();
				await terminal.flush();
				assert.deepEqual(terminal.getCursorPosition(), { x: 4, y: 1 });
				assert.ok(terminal.writes.includes(CLEANUP));
			} finally {
				tui.stop();
			}
		});
	}

	it("fullscreen built-in image redraw and resize notify external surfaces of placement loss", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		let image = new Image(
			CHECKERBOARD,
			"image/png",
			{ fallbackColor: (text) => text },
			{ imageId: 100, maxHeightCells: 1 },
		);
		const builtin: Component = { render: (width) => image.render(width), invalidate: () => image.invalidate() };
		const panel = new Panel();
		tui.setLayoutRoot(
			new VStack([
				{ component: builtin, basis: 1 },
				{ component: panel, basis: 2 },
			]),
		);
		const handle = tui.trackSurface(panel);
		const frames: SurfaceRenderContext[] = [];
		handle.onRender((frame) => {
			frames.push(frame);
			if (!frame.disposed) frame.write(EXTERNAL_IMAGE);
		});
		tui.start();
		try {
			tui.renderNow();
			const offset = terminal.writes.length;
			image = new Image(
				CHECKERBOARD,
				"image/png",
				{ fallbackColor: (text) => text },
				{ imageId: 101, maxHeightCells: 1 },
			);
			tui.renderNow();
			const writes = terminal.writes.slice(offset);
			assert.equal(frames.at(-1)!.graphicsInvalidation, "placements");
			assert.deepEqual(frames[0].geometry, frames[1].geometry);
			assert.ok(writes.indexOf(EXTERNAL_IMAGE) > writes.findIndex((write) => write.includes("d=a,q=2")));
			assert.ok(writes.indexOf(EXTERNAL_IMAGE) > writes.findIndex((write) => write.includes("i=101")));
			terminal.resize(32, 12);
			tui.renderNow();
			assert.equal(frames.at(-1)!.graphicsInvalidation, "placements");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
});
