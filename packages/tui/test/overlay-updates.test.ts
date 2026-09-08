import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("dynamic overlay layout", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`${Renderer.name}: allocation pads, clips, resizes and publishes committed bounds`, async () => {
			const terminal = new VirtualTerminal(40, 12);
			const tui = new Renderer(terminal);
			const panel: Component = { render: () => ["one", "two", "three"], invalidate: () => {} };
			const surface = tui.trackSurface(panel);
			const handle = tui.showOverlay(panel, { width: 10, height: 5, row: 100, col: 100 });
			tui.start();
			try {
				tui.renderNow();
				assert.deepEqual(handle.getBounds(), { row: 7, col: 30, width: 10, height: 5 });
				assert.deepEqual(surface.getGeometry()?.bounds, { x: 30, y: 7, width: 10, height: 5 });
				handle.updateOptions({ height: 2, width: "50%", row: 0, col: 0 });
				assert.equal(handle.getBounds()?.row, 7);
				tui.renderNow();
				await terminal.flush();
				assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width: 20, height: 2 });
				assert.equal(terminal.getViewport()[0].trimEnd(), "one");
				assert.equal(terminal.getViewport()[1].trimEnd(), "two");
				assert.ok(!terminal.getViewport().join("\n").includes("three"));
				handle.updateOptions({ height: "50%", maxHeight: 4 });
				tui.renderNow();
				assert.equal(handle.getBounds()?.height, 4);
				terminal.resize(30, 6);
				tui.renderNow();
				assert.equal(handle.getBounds()?.height, 3);
				handle.updateOptions({ height: undefined, maxHeight: undefined });
				tui.renderNow();
				assert.equal(handle.getBounds()?.height, 3);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: a drag clamped below the screen can release and start again`, () => {
			const terminal = new VirtualTerminal(40, 12);
			const tui = new Renderer(terminal);
			let handle: OverlayHandle;
			const events: TuiMouseEvent[] = [];
			const panel: Component = {
				render: () => ["chrome", "image"],
				invalidate: () => {},
				handleMouse: (event) => {
					events.push(event);
					if (event.type === "drag") handle.updateOptions({ row: event.screenY });
					return { handled: true, capture: event.type === "press", render: true };
				},
			};
			const surface = tui.trackSurface(panel, { mouse: true });
			handle = tui.showOverlay(panel, { row: 1, col: 1, width: 10, height: 4 });
			tui.start();
			try {
				tui.renderNow();
				terminal.sendInput("\x1b[<0;2;2M");
				terminal.sendInput("\x1b[<32;2;12M");
				tui.renderNow();
				assert.equal(handle.getBounds()?.row, 8);
				assert.equal(surface.getGeometry()?.bounds.y, 8);
				terminal.sendInput("\x1b[<0;2;12m");
				terminal.sendInput("\x1b[<0;2;9M");
				terminal.sendInput("\x1b[<32;2;4M");
				tui.renderNow();
				terminal.sendInput("\x1b[<0;2;4m");
				assert.equal(handle.getBounds()?.row, 3);
				assert.equal(events.filter((event) => event.type === "press").length, 2);
				assert.equal(events.filter((event) => event.type === "release").length, 2);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: updated visibility restores focus and removed handles cannot resurrect overlays`, () => {
			const tui = new Renderer(new VirtualTerminal(40, 12));
			const editor: Component = { render: () => ["editor"], invalidate: () => {} };
			const panel: Component = { render: () => ["panel"], invalidate: () => {} };
			tui.addChild(editor);
			tui.setFocus(editor);
			const handle = tui.showOverlay(panel);
			tui.start();
			try {
				handle.updateOptions({ visible: () => false });
				assert.equal(tui.getFocusedComponent(), editor);
				handle.updateOptions({ visible: undefined, nonCapturing: true });
				handle.setHidden(true);
				handle.setHidden(false);
				assert.equal(tui.getFocusedComponent(), editor);
				handle.hide();
				handle.updateOptions({ nonCapturing: false });
				handle.setHidden(true);
				handle.setHidden(false);
				handle.focus();
				assert.equal(tui.getFocusedComponent(), editor);
				assert.equal(handle.getBounds(), undefined);
			} finally {
				tui.stop();
			}
		});
	}
});
