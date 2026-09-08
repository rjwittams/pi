import { Text, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createCustomUI } from "../src/modes/interactive/custom-ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("custom UI ownership", () => {
	test("raw overlay removal cancels the prompt while temporary hiding retains it", async () => {
		initTheme("dark");
		const tui = new TuiMainScreen(new VirtualTerminal());
		let disposed = 0;
		tui.start();
		const prompt = createCustomUI(
			tui,
			theme,
			new KeybindingsManager(),
			() => ({
				render: () => ["panel"],
				invalidate: () => {},
				dispose: () => disposed++,
			}),
			{
				overlay: true,
				onHandle: (handle) => {
					handle.setHidden(true);
					expect(disposed).toBe(0);
					handle.setHidden(false);
					tui.hideOverlay();
				},
			},
			() => {},
			() => {},
		);
		try {
			await expect(prompt.result).rejects.toThrow("removed");
			expect(disposed).toBe(1);
		} finally {
			tui.stop();
		}
	});
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		test(`${Renderer.name}: closing one prompt leaves a newer overlay alone and disposes graphics first`, async () => {
			initTheme("dark");
			const tui = new Renderer(new VirtualTerminal());
			const events: string[] = [];
			let done!: (value: string) => void;
			let scoped!: TUI;
			tui.start();
			const prompt = createCustomUI(
				tui,
				theme,
				new KeybindingsManager(),
				(ui, _theme, _keys, close) => {
					done = close;
					scoped = ui;
					const panel = { render: () => ["owned"], invalidate: () => {}, dispose: () => events.push("component") };
					ui.trackSurface(panel).onRender((frame) => {
						if (frame.disposed) events.push(`graphics:${frame.write("")}`);
					});
					return panel;
				},
				{ overlay: true },
				() => {},
				() => {},
			);
			try {
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				const newer = new Text("newer");
				tui.showOverlay(newer);
				done("ok");
				expect(await prompt.result).toBe("ok");
				expect(tui.getFocusedComponent()).toBe(newer);
				expect(events).toEqual(["graphics:true", "component"]);
				expect(() => scoped.trackSurface(newer)).toThrow("disposed");
			} finally {
				tui.stop();
			}
		});

		test(`${Renderer.name}: renderer stop cleans pending factory resources and disposes its late result`, async () => {
			initTheme("dark");
			const tui = new Renderer(new VirtualTerminal());
			const events: string[] = [];
			let complete!: (component: Text & { dispose(): void }) => void;
			tui.start();
			const prompt = createCustomUI(
				tui,
				theme,
				new KeybindingsManager(),
				(ui) => {
					ui.trackSurface(new Text("pending")).onRender((frame) => {
						if (frame.disposed) events.push("surface");
					});
					return new Promise((resolve) => {
						complete = resolve;
					});
				},
				{ overlay: true },
				() => {},
				() => {},
			);
			const rejected = expect(prompt.result).rejects.toThrow("renderer stopped");
			await Promise.resolve();
			tui.stop();
			await rejected;
			complete(Object.assign(new Text("late"), { dispose: () => events.push("component") }));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual(["surface", "component"]);
			expect(tui.hasOverlay()).toBe(false);
		});
	}

	test("factory and onHandle failures release all owned surfaces", async () => {
		initTheme("dark");
		for (const failure of ["factory", "handle"]) {
			const tui = new TuiMainScreen(new VirtualTerminal());
			let disposed = 0;
			tui.start();
			const prompt = createCustomUI(
				tui,
				theme,
				new KeybindingsManager(),
				(ui) => {
					const panel = new Text("panel");
					ui.trackSurface(panel).onRender((frame) => {
						if (frame.disposed) disposed++;
					});
					if (failure === "factory") throw new Error("factory failed");
					return panel;
				},
				{
					overlay: true,
					onHandle: () => {
						throw new Error("handle failed");
					},
				},
				() => {},
				() => {},
			);
			try {
				await expect(prompt.result).rejects.toThrow(`${failure} failed`);
				expect(disposed).toBe(1);
				expect(tui.hasOverlay()).toBe(false);
			} finally {
				tui.stop();
			}
		}
	});

	test("host cancellation and a synchronous done both dispose late returned components", async () => {
		initTheme("dark");
		const tui = new TuiMainScreen(new VirtualTerminal());
		let disposed = 0;
		tui.start();
		try {
			const prompt = createCustomUI(
				tui,
				theme,
				new KeybindingsManager(),
				(_ui, _theme, _keys, done) => {
					done(42);
					return { render: () => [], invalidate: () => {}, dispose: () => disposed++ };
				},
				{ overlay: true },
				() => {},
				() => {},
			);
			expect(await prompt.result).toBe(42);
			await Promise.resolve();
			await Promise.resolve();
			expect(disposed).toBe(1);
			const pending = createCustomUI(
				tui,
				theme,
				new KeybindingsManager(),
				() => {
					throw new Error("must not run");
				},
				undefined,
				() => {},
				() => {},
			);
			pending.cancel();
			await expect(pending.result).rejects.toThrow("cancelled");
		} finally {
			tui.stop();
		}
	});
});
