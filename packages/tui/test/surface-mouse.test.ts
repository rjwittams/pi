import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings } from "../src/keybindings.ts";
import { type Component, Container, CURSOR_MARKER, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MouseTerminal extends VirtualTerminal {
	writes: string[] = [];
	startupRow = 0;
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
		if (data === "\x1b[6n") this.sendInput(`\x1b[${this.startupRow + 1};1R`);
	}

	mouse(button: number, x: number, y: number, release = false): void {
		this.sendInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	}
}

class Panel implements Component {
	lines = ["panel", "body"];
	events: TuiMouseEvent[] = [];
	keys: string[] = [];
	cancellations = 0;
	onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined = (event) =>
		event.type === "press" ? { capture: true, focus: true } : { handled: true, render: false };
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.events.push(event);
		return this.onMouse(event);
	}
	handleMouseCancel(): void {
		this.cancellations++;
	}
}

describe("surface mouse lifetime", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		for (const release of ["outside press", "Ctrl+G"] as const) {
			it(`${Renderer.name}: non-capturing panel releases focus with ${release}`, () => {
				const terminal = new MouseTerminal(30, 12);
				const tui = new Renderer(terminal);
				const composer = new Panel();
				const panel = new Panel();
				tui.addChild(composer);
				tui.setFocus(composer);
				tui.trackSurface(panel, { mouse: true });
				tui.showOverlay(panel, { row: 4, col: 2, width: 10, nonCapturing: true });
				tui.start();
				try {
					tui.renderNow();
					terminal.mouse(0, 3, 4);
					terminal.mouse(0, 3, 4, true);
					terminal.sendInput("55");
					assert.equal(tui.getFocusedComponent(), panel);
					if (release === "outside press") terminal.mouse(0, 20, 10);
					else terminal.sendInput("\x07");
					assert.equal(tui.getFocusedComponent(), composer);
					terminal.sendInput("ready");
					tui.renderNow();
					terminal.sendInput(" again");
					assert.deepEqual(composer.keys, ["ready", " again"]);
					assert.deepEqual(panel.keys, ["55"]);
					terminal.mouse(0, 3, 4);
					assert.equal(tui.getFocusedComponent(), panel);
				} finally {
					tui.stop();
				}
			});
		}

		it(`${Renderer.name}: stop cancels capture and restart schedules fresh geometry`, async () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.addChild(panel);
			const old = tui.trackSurface(panel, { mouse: true });
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.mouse(0, 1, 0);
				tui.stop();
				assert.equal(panel.cancellations, 1);
				assert.equal(old.getGeometry(), undefined);
				panel.lines = ["restarted"];
				tui.start();
				const fresh = tui.trackSurface(panel, { mouse: true });
				await terminal.waitForRender();
				assert.equal(fresh.getGeometry()!.bounds.height, 1);
				assert.ok(terminal.writes.some((write) => write.includes("restarted")));
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: disposal inside a press cannot reacquire focus or capture`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			const composer = new Panel();
			tui.addChild(panel);
			tui.addChild(composer);
			tui.setFocus(composer);
			const handle = tui.trackSurface(panel, { mouse: true });
			panel.onMouse = () => {
				handle.dispose();
				tui.renderNow();
				return { focus: true, capture: true };
			};
			tui.start();
			try {
				tui.renderNow();
				terminal.mouse(0, 1, 0);
				assert.equal(tui.getFocusedComponent(), composer);
				assert.equal(panel.cancellations, 1);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: focus loss cancels once and an outside press restores the composer`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			const composer = new Panel();
			tui.addChild(panel);
			tui.addChild(composer);
			tui.setFocus(composer);
			tui.trackSurface(panel, { mouse: true });
			tui.start();
			try {
				tui.renderNow();
				terminal.mouse(0, 1, 0);
				terminal.sendInput("\x1b[O");
				terminal.sendInput("\x1b[O");
				assert.equal(panel.cancellations, 1);
				terminal.mouse(0, 1, 0);
				terminal.mouse(0, 20, 10);
				assert.equal(tui.getFocusedComponent(), composer);
				assert.equal(panel.cancellations, 2);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: captures using committed overlay bounds after moving and clamping`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.trackSurface(panel, { mouse: true });
			const options = { row: 2, col: 3, width: 10 };
			tui.start();
			try {
				tui.showOverlay(panel, options);
				tui.renderNow();
				terminal.mouse(0, 4, 2);
				options.row = 50;
				options.col = 8;
				options.width = 12;
				tui.renderNow();
				terminal.mouse(32, 10, 11);
				terminal.mouse(3, 10, 11, true);
				assert.deepEqual(
					panel.events.map((event) => [event.type, event.x, event.y, event.width]),
					[
						["press", 1, 0, 10],
						["drag", 2, 1, 12],
						["release", 2, 1, 12],
					],
				);
				assert.equal(panel.events.at(-1)!.button, "left");
				terminal.mouse(0, 9, 10);
				terminal.mouse(0, 9, 10, true);
				assert.equal(panel.events.at(-1)!.type, "click");
				assert.equal(panel.cancellations, 0);
			} finally {
				tui.stop();
			}
		});

		for (const closeOn of ["press", "release"] as const) {
			it(`${Renderer.name}: closing inside ${closeOn} cannot refocus or click a removed overlay`, () => {
				const terminal = new MouseTerminal(30, 12);
				const tui = new Renderer(terminal);
				const composer = new Panel();
				const panel = new Panel();
				tui.addChild(composer);
				tui.setFocus(composer);
				tui.trackSurface(panel, { mouse: true });
				tui.start();
				try {
					const overlay = tui.showOverlay(panel, { row: 4, col: 2, width: 10 });
					panel.onMouse = (event) => {
						if (event.type === closeOn) overlay.hide();
						return { focus: true, capture: true };
					};
					tui.renderNow();
					terminal.mouse(0, 3, 4);
					terminal.mouse(0, 3, 4, true);
					terminal.sendInput("ready");
					assert.equal(tui.getFocusedComponent(), composer);
					assert.deepEqual(composer.keys, ["ready"]);
					assert.deepEqual(
						panel.events.map((event) => event.type),
						closeOn === "press" ? ["press"] : ["press", "release"],
					);
				} finally {
					tui.stop();
				}
			});
		}

		it(`${Renderer.name}: hiding a captured overlay cancels once and allows another gesture`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			tui.trackSurface(panel, { mouse: true });
			tui.start();
			try {
				const overlay = tui.showOverlay(panel, { row: 4, col: 2, width: 10 });
				tui.renderNow();
				terminal.mouse(0, 3, 4);
				overlay.setHidden(true);
				tui.renderNow();
				terminal.mouse(32, 20, 10);
				terminal.mouse(0, 20, 10, true);
				assert.equal(panel.cancellations, 1);
				assert.equal(panel.events.length, 1);
				overlay.setHidden(false);
				tui.renderNow();
				terminal.mouse(0, 3, 4);
				terminal.mouse(0, 3, 4, true);
				assert.equal(panel.events.at(-1)!.type, "click");
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: inline disposal cancels capture and restores composer focus`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			const composer = new Panel();
			const box = new Box(2, 1);
			box.addChild(panel);
			tui.addChild(box);
			tui.addChild(composer);
			tui.setFocus(composer);
			const handle = tui.trackSurface(panel, { mouse: true });
			tui.start();
			try {
				tui.renderNow();
				terminal.mouse(0, 3, 1);
				assert.equal(tui.getFocusedComponent(), panel);
				assert.deepEqual([panel.events[0].x, panel.events[0].y], [1, 0]);
				handle.dispose();
				handle.dispose();
				terminal.sendInput("ready");
				assert.equal(panel.cancellations, 1);
				assert.equal(tui.getFocusedComponent(), composer);
				assert.deepEqual(composer.keys, ["ready"]);
			} finally {
				tui.stop();
			}
		});

		it(`${Renderer.name}: inline removal restores focus before the next keyboard input`, () => {
			const terminal = new MouseTerminal(30, 12);
			const tui = new Renderer(terminal);
			const panel = new Panel();
			const composer = new Panel();
			tui.addChild(panel);
			tui.addChild(composer);
			tui.setFocus(composer);
			tui.trackSurface(panel, { mouse: true });
			tui.start();
			try {
				tui.renderNow();
				terminal.mouse(0, 1, 0);
				tui.removeChild(panel);
				terminal.sendInput("ready");
				assert.equal(tui.getFocusedComponent(), composer);
				assert.deepEqual(composer.keys, ["ready"]);
				assert.equal(panel.cancellations, 1);
			} finally {
				tui.stop();
			}
		});
	}

	it("regular mouse reporting is opt-in, reference counted, and leaves no input listener after restart", () => {
		const terminal = new MouseTerminal(30, 12);
		const tui = new TuiMainScreen(terminal);
		const panel = new Panel();
		tui.addChild(panel);
		tui.setFocus(panel);
		tui.start();
		try {
			tui.renderNow();
			assert.ok(!terminal.writes.join("").includes("\x1b[?1002h"));
			const a = tui.trackSurface(panel, { mouse: true });
			const b = tui.trackSurface(panel, { mouse: true });
			tui.renderNow();
			assert.equal(terminal.writes.filter((write) => write.includes("\x1b[?1002h")).length, 1);
			a.dispose();
			assert.ok(!terminal.writes.join("").includes("\x1b[?1002l"));
			b.dispose();
			assert.equal(terminal.writes.filter((write) => write.includes("\x1b[?1002l")).length, 1);
			terminal.mouse(0, 1, 0, true);
			assert.deepEqual(panel.keys, []);
			tui.trackSurface(panel, { mouse: true });
			tui.stop();
			tui.start();
			tui.trackSurface(panel, { mouse: true });
			tui.renderNow();
			terminal.mouse(0, 1, 0);
			assert.equal(panel.events.length, 1);
		} finally {
			tui.stop();
		}
	});

	it("fullscreen scroll-out cancels inline capture and restores the dock", () => {
		const terminal = new MouseTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		const panel = new Panel();
		const composer = new Panel();
		const content = new Container();
		content.addChild(panel);
		const filler = new Panel();
		filler.lines = Array.from({ length: 20 }, () => "filler");
		content.addChild(filler);
		const scroll = new ScrollView(content);
		tui.setLayoutRoot(new VStack([{ component: scroll, basis: 6, shrink: 0 }, composer]));
		tui.setFocus(composer);
		tui.trackSurface(panel);
		tui.start();
		try {
			tui.renderNow();
			terminal.mouse(0, 1, 0);
			scroll.scrollTo(5);
			tui.renderNow();
			assert.equal(panel.cancellations, 1);
			assert.equal(tui.getFocusedComponent(), composer);
		} finally {
			tui.stop();
		}
	});

	it("surface focus release uses the configured binding", () => {
		const terminal = new MouseTerminal(30, 12);
		const tui = new TuiMainScreen(terminal);
		const panel = new Panel();
		const composer = new Panel();
		const keybindings = getKeybindings();
		const previous = keybindings.getUserBindings();
		keybindings.setUserBindings({ ...previous, "tui.surface.releaseFocus": "ctrl+x" });
		tui.addChild(panel);
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.trackSurface(panel, { mouse: true });
		tui.start();
		try {
			tui.renderNow();
			terminal.mouse(0, 1, 0);
			terminal.sendInput("\x07");
			assert.equal(tui.getFocusedComponent(), panel);
			terminal.sendInput("\x18");
			assert.equal(tui.getFocusedComponent(), composer);
			assert.deepEqual(panel.keys, ["\x07"]);
		} finally {
			tui.stop();
			keybindings.setUserBindings(previous);
		}
	});

	it("regular mode translates mouse coordinates from a nonzero startup row", async () => {
		const terminal = new MouseTerminal(30, 12);
		terminal.startupRow = 4;
		terminal.write("\x1b[5;1H");
		await terminal.flush();
		const tui = new TuiMainScreen(terminal);
		const panel = new Panel();
		tui.addChild(panel);
		tui.trackSurface(panel, { mouse: true });
		tui.start();
		try {
			tui.renderNow();
			terminal.mouse(0, 1, 0);
			assert.equal(panel.events.length, 0);
			terminal.mouse(0, 1, 5);
			assert.deepEqual([panel.events[0].x, panel.events[0].y], [1, 1]);
		} finally {
			tui.stop();
		}
	});

	it("fullscreen distinguishes raw wheel steps from accelerated viewport lines", () => {
		const terminal = new MouseTerminal(30, 12);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 4 });
		const panel = new Panel();
		tui.addChild(panel);
		tui.start();
		try {
			tui.renderNow();
			terminal.mouse(65 + 8, 1, 0);
			assert.equal(panel.events[0].wheelSteps, 1);
			assert.equal(panel.events[0].wheelDelta, 20);
		} finally {
			tui.stop();
		}
	});

	it("fullscreen dispatches nested content at the cursor-scrolled source row", () => {
		const terminal = new MouseTerminal(30, 12);
		const tui = new TuiAltScreen(terminal);
		const panel = new Panel();
		panel.lines = ["panel", `body${CURSOR_MARKER}`];
		const spacer = new Panel();
		spacer.lines = ["one", "two", "three"];
		const container = new Container();
		container.addChild(spacer);
		container.addChild(panel);
		tui.setLayoutRoot(new VStack([{ component: container, basis: 2, shrink: 0 }]));
		tui.trackSurface(panel);
		tui.start();
		try {
			tui.renderNow();
			terminal.mouse(0, 1, 0);
			terminal.mouse(32, 2, 1);
			assert.deepEqual(
				panel.events.map((event) => [event.type, event.x, event.y]),
				[
					["press", 1, 0],
					["drag", 2, 1],
				],
			);
			assert.equal(spacer.events.length, 0);
		} finally {
			tui.stop();
		}
	});
});
