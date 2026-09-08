import { type SurfaceRenderContext, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent, CustomMessageContainer } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTuiReference } from "../src/modes/interactive/tui-renderer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
		if (data === "\x1b[6n") this.sendInput("\x1b[1;1R");
	}
	override stop(): void {
		this.writes.push("stopped");
		super.stop();
	}
}

const message: CustomMessage = {
	role: "custom",
	customType: "surface",
	content: "fallback",
	display: true,
	timestamp: 0,
};

describe("CustomMessageComponent", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		test(`${Renderer.name}: attaches after text rendering, cleans up on stop, and recreates on restart`, () => {
			initTheme("dark");
			const terminal = new RecordingTerminal(40, 15);
			const tui = new Renderer(terminal);
			const optionsSeen: MessageRenderOptions[] = [];
			const frames: SurfaceRenderContext[] = [];
			const component = new CustomMessageComponent(
				message,
				(_message, options) => {
					optionsSeen.push(options);
					const panel = new Text("panel", 0, 0);
					let disposed = false;
					const surface = options.ui!.trackSurface(panel, { mouse: true });
					const unsubscribe = surface.onRender((frame) => {
						frames.push(frame);
						if (frame.disposed) frame.write("\x1b_Ga=d,d=i,i=9001\x1b\\");
					});
					options.ui!.onDispose(() => {
						disposed = true;
						unsubscribe();
						terminal.writes.push("producer disposed");
					});
					return {
						render: (width) => {
							if (disposed) throw new Error("Disposed producer must not render");
							return panel.render(width);
						},
						invalidate: () => panel.invalidate(),
						getRenderedChildren: () => [{ component: panel, bounds: { x: 0, y: 0, width: 40, height: 1 } }],
					};
				},
				undefined,
				1,
				tui,
			);
			tui.addChild(component);
			expect(tui.isRunning).toBe(false);
			tui.renderNow();
			expect(optionsSeen).toHaveLength(0);
			tui.start();
			try {
				tui.renderNow();
				tui.renderNow();
				expect(optionsSeen).toHaveLength(1);
				expect(frames.at(-1)?.geometry?.bounds.width).toBe(40);
				const offset = terminal.writes.length;
				tui.stop();
				const writes = terminal.writes.slice(offset);
				expect(writes.indexOf("\x1b_Ga=d,d=i,i=9001\x1b\\")).toBeLessThan(writes.indexOf("producer disposed"));
				expect(writes.indexOf("producer disposed")).toBeLessThan(writes.indexOf("stopped"));
				expect(frames.at(-1)?.disposed).toBe(true);
				expect(frames.at(-1)?.write("stale")).toBe(false);
				component.invalidate();
				expect(component.render(40).map(stripAnsi).join("\n")).toContain("panel");
				expect(component.render(20).map(stripAnsi).join("\n")).toContain("fallback");
				expect(optionsSeen).toHaveLength(1);
				tui.start();
				tui.renderNow();
				tui.renderNow();
				expect(optionsSeen).toHaveLength(2);
				expect(optionsSeen[1].ui).not.toBe(optionsSeen[0].ui);
				expect(() => optionsSeen[0].ui!.trackSurface(new Text("late"))).toThrow("disposed");
			} finally {
				tui.stop();
			}
		});

		test(`${Renderer.name}: replacement and removal release resources once, including during text rendering`, () => {
			initTheme("dark");
			const terminal = new RecordingTerminal(40, 15);
			const tui = new Renderer(terminal);
			const events: string[] = [];
			let disposeDuringRender = false;
			const component = new CustomMessageComponent(
				message,
				(_message, options) => {
					events.push(`create:${options.outputPad}:${options.expanded}`);
					const panel = {
						render: () => {
							if (disposeDuringRender) component.dispose();
							return ["panel"];
						},
						invalidate: () => {},
						dispose: () => events.push("component disposed"),
					};
					const unsubscribe = options.ui!.trackSurface(panel).onRender((frame) => {
						if (frame.disposed) events.push(`graphics:${frame.write("\x1b_Ga=d,d=i,i=9001\x1b\\")}`);
					});
					options.ui!.onDispose(() => {
						unsubscribe();
						events.push("producer disposed");
					});
					return panel;
				},
				undefined,
				1,
				tui,
			);
			tui.addChild(component);
			tui.start();
			try {
				tui.renderNow();
				tui.renderNow();
				component.setOutputPad(0);
				component.setExpanded(true);
				tui.renderNow();
				expect(events).toEqual([
					"create:1:false",
					"graphics:true",
					"producer disposed",
					"component disposed",
					"create:0:true",
				]);
				disposeDuringRender = true;
				tui.renderNow();
				component.dispose();
				tui.removeChild(component);
				tui.renderNow();
				tui.stop();
				expect(events.slice(5)).toEqual(["graphics:true", "producer disposed", "component disposed"]);
			} finally {
				tui.stop();
			}
		});

		test(`${Renderer.name}: failed factories clean up and render fallback without a retry loop`, () => {
			initTheme("dark");
			const tui = new Renderer(new RecordingTerminal(40, 15));
			const events: string[] = [];
			const component = new CustomMessageComponent(
				message,
				(_message, options) => {
					events.push("factory");
					options.ui!.trackSurface(new Text("unused")).onRender((frame) => {
						if (frame.disposed) events.push("graphics");
					});
					options.ui!.onDispose(() => {
						throw new Error("cleanup failure");
					});
					options.ui!.onDispose(() => events.push("producer"));
					throw new Error("factory failure");
				},
				undefined,
				1,
				tui,
			);
			tui.addChild(component);
			tui.start();
			try {
				tui.renderNow();
				tui.renderNow();
				expect(events).toEqual(["factory", "graphics", "producer"]);
				expect(component.render(40).map(stripAnsi).join("\n")).toContain("fallback");
			} finally {
				tui.stop();
			}
		});
	}

	test.each(["clear", "removeChild"] as const)("transcript %s disposes the owned message", (operation) => {
		initTheme("dark");
		const tui = new TuiMainScreen(new RecordingTerminal());
		const transcript = new CustomMessageContainer();
		let disposals = 0;
		const component = new CustomMessageComponent(
			message,
			(_message, options) => {
				options.ui!.onDispose(() => disposals++);
				return new Text("panel");
			},
			undefined,
			1,
			tui,
		);
		transcript.addChild(component);
		tui.addChild(transcript);
		tui.start();
		try {
			tui.renderNow();
			transcript[operation](component);
			expect(disposals).toBe(1);
			expect(transcript.children).toHaveLength(0);
			tui.stop();
			expect(disposals).toBe(1);
		} finally {
			tui.stop();
		}
	});

	test("standalone custom components are disposed on replacement and removal", () => {
		initTheme("dark");
		let disposals = 0;
		const component = new CustomMessageComponent(message, () => ({
			render: () => ["panel"],
			invalidate: () => {},
			dispose: () => disposals++,
		}));
		component.invalidate();
		expect(disposals).toBe(1);
		component.dispose();
		component.dispose();
		expect(disposals).toBe(2);
	});

	test("renderer replacement recreates the attachment through the stable TUI reference", () => {
		initTheme("dark");
		const terminal = new RecordingTerminal(40, 15);
		let renderer: TuiMainScreen | TuiAltScreen = new TuiMainScreen(terminal);
		const ui = createInteractiveTuiReference(() => renderer);
		const events: string[] = [];
		const component = new CustomMessageComponent(
			message,
			(_message, options) => {
				events.push(`create:${ui.mode}`);
				const mode = ui.mode;
				options.ui!.onDispose(() => events.push(`dispose:${mode}`));
				const panel = new Text("panel");
				options.ui!.trackSurface(panel);
				return panel;
			},
			undefined,
			1,
			ui,
		);
		renderer.addChild(component);
		renderer.start();
		try {
			renderer.renderNow();
			renderer.stop({ preserveScreen: true });
			renderer.clear();
			renderer = new TuiAltScreen(terminal);
			renderer.addChild(component);
			renderer.invalidate();
			renderer.renderNow();
			expect(events).toEqual(["create:regular", "dispose:regular"]);
			renderer.start();
			renderer.renderNow();
			expect(events).toEqual(["create:regular", "dispose:regular", "create:fullscreen"]);
		} finally {
			renderer.stop();
		}
	});

	test("a message removed before its first frame never starts its renderer", () => {
		initTheme("dark");
		const tui = new TuiMainScreen(new RecordingTerminal());
		let calls = 0;
		const component = new CustomMessageComponent(
			message,
			() => {
				calls++;
				return new Text("panel");
			},
			undefined,
			1,
			tui,
		);
		component.dispose();
		tui.addChild(component);
		tui.start();
		try {
			tui.renderNow();
			expect(calls).toBe(0);
		} finally {
			tui.stop();
		}
	});

	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});
