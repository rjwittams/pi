import { Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { SurfaceRegistry } from "../../tui/src/surface.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SurfaceLabContent } from "../examples/extensions/terminal-surface-demo.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("terminal surface example", () => {
	test("clips the source image on both axes and reuploads only after image loss", () => {
		initTheme("dark");
		const writes: string[] = [];
		const registry = new SurfaceRegistry({
			requestRender: () => {},
			createWriter: () => (data) => {
				writes.push(data);
				return true;
			},
			cleanup: (callback) => callback(),
		});
		const panel = new SurfaceLabContent(theme);
		panel.attachSurface(registry.track(panel));
		panel.render(56);
		// Image is at (-6,-4), with size 50x12; only 20x5 cells are visible.
		const geometries = new Map([
			[
				panel,
				{
					bounds: { x: -10, y: -8, width: 56, height: 20 },
					clip: { x: 0, y: 0, width: 20, height: 5 },
					contentOffset: 0,
				},
			],
		]);
		registry.commit(geometries, "images");
		expect(writes.join("")).toContain("a=t,f=32");
		expect(writes.join("")).toContain("\x1b[1;1H");
		expect(writes.join("")).toContain("c=20,r=5,x=23,y=42,w=77,h=54");
		const payloads = [...writes.join("").matchAll(/\x1b_G[^;\x1b]*;([^\x1b]*)\x1b\\/g)].map((match) => match[1]!);
		expect(payloads.every((payload) => payload.length <= 4096)).toBe(true);
		expect(Buffer.from(payloads.join(""), "base64")).toHaveLength(192 * 128 * 4);
		writes.length = 0;
		registry.commit(geometries, "placements");
		expect(writes.join("")).toContain("a=p,C=1");
		expect(writes.join("")).not.toContain("a=t,f=32");
		writes.length = 0;
		registry.commit(geometries, "images");
		expect(writes.join("")).toContain("a=t,f=32");
		writes.length = 0;
		registry.commit(new Map(), "none");
		expect(writes.join("")).toContain("a=d,d=i");
		expect(writes.join("")).not.toContain("a=p,");
		panel.dispose();
		expect(writes.at(-1)).toContain("a=d,d=I");
	});
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		test(`${Renderer.name}: release after dragging beyond the bottom permits another drag`, async () => {
			initTheme("dark");
			const terminal = new VirtualTerminal(100, 32);
			const tui = new Renderer(terminal);
			const writes = vi.spyOn(terminal, "write");
			const panel = new SurfaceLabContent(theme, () => {});
			const surface = tui.trackSurface(panel, { mouse: true });
			panel.attachSurface(surface);
			tui.addChild(new Text("composer"));
			const overlay = tui.showOverlay(panel, {
				row: 3,
				col: 4,
				width: 56,
				height: 20,
				margin: 1,
				nonCapturing: true,
			});
			panel.attachOverlay(overlay);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[<0;10;5M");
				terminal.sendInput("\x1b[<32;10;32M");
				await terminal.waitForRender();
				terminal.sendInput("\x1b[<0;10;32m");
				const bottom = overlay.getBounds()!;
				expect(bottom.row).toBe(11);
				terminal.sendInput(`\x1b[<0;10;${bottom.row + 2}M`);
				terminal.sendInput(`\x1b[<32;15;${bottom.row - 1}M`);
				terminal.sendInput(`\x1b[<0;15;${bottom.row - 1}m`);
				await terminal.waitForRender();
				expect(overlay.getBounds()).toMatchObject({ row: 8, col: 9 });
				// Reflow to a clamped height must keep the bottom border attached.
				terminal.resize(60, 16);
				await terminal.waitForRender();
				await terminal.waitForRender();
				const resized = overlay.getBounds()!;
				expect(panel.render(resized.width)).toHaveLength(resized.height);
				expect(panel.render(resized.width).at(-1)).toContain("╰");
				expect(writes.mock.calls.some(([data]) => data.includes("a=t,f=32"))).toBe(true);
				writes.mockClear();
				overlay.hide();
				panel.dispose();
				expect(writes.mock.calls.map(([data]) => data).join("")).toContain("a=d,d=I");
			} finally {
				panel.dispose();
				tui.stop();
			}
		});
	}
});
