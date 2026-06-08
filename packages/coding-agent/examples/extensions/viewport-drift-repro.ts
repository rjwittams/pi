/**
 * Viewport Drift Repro
 *
 * Reproduces an overlay border drift bug in Pi's differential renderer.
 * The overlay border visibly shifts up/down as the composer's autocomplete
 * list expands and collapses (triggered by typing "/" in the composer).
 *
 * Usage: pi --extension ./examples/extensions/viewport-drift-repro.ts
 *
 * Commands:
 *   /viewport-drift-repro  - Open a persistent non-capturing overlay anchored
 *                            top-right. Type "/" in the composer to trigger
 *                            autocomplete and observe the border drifting.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("viewport-drift-repro", {
		description: "Open a persistent non-capturing overlay to reproduce border drift",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Do NOT await the custom() call — awaiting holds the slash-command
			// runtime in "command active" state and eats composer input. Returning
			// from the handler lets Pi resume normal input routing while the
			// non-capturing overlay persists in the background.
			void ctx.ui
				.custom<void>(
					(tui, theme, _kb, _done) => {
						const panel = new DriftReproPanel(theme);
						setInterval(() => {
							panel.tick();
							tui.requestRender();
						}, 1000);
						return panel;
					},
					{
						overlay: true,
						overlayOptions: {
							// right-center matches terminal-surface-demo and makes the
							// drift more obvious — the overlay sits in the middle of the
							// viewport so a viewportTop change shifts it bodily rather
							// than clipping against the top edge.
							anchor: "right-center",
							width: 36,
							margin: { top: 2, right: 2, bottom: 2 },
							nonCapturing: true,
						},
					},
				)
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`viewport-drift-repro failed: ${message}`, "error");
				});
		},
	});
}

class DriftReproPanel implements Component {
	private ticks = 0;

	private theme: Theme;
	constructor(theme: Theme) {
		this.theme = theme;
	}

	tick(): void {
		this.ticks++;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);

		const pad = (s: string): string => truncateToWidth(s, innerW, "...", true);

		const lines: string[] = [];

		// Top border
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// Header
		lines.push(th.fg("border", "│") + pad(th.fg("accent", " Viewport Drift Repro")) + th.fg("border", "│"));

		// Blank line
		lines.push(th.fg("border", "│") + pad("") + th.fg("border", "│"));

		// Tick counter
		lines.push(th.fg("border", "│") + pad(` tick: ${th.fg("accent", String(this.ticks))}`) + th.fg("border", "│"));

		// Blank line
		lines.push(th.fg("border", "│") + pad("") + th.fg("border", "│"));

		// Help text lines
		lines.push(th.fg("border", "│") + pad(th.fg("dim", " Type in composer below.")) + th.fg("border", "│"));
		lines.push(th.fg("border", "│") + pad(th.fg("dim", " Watch border drift up/down")) + th.fg("border", "│"));
		lines.push(th.fg("border", "│") + pad(th.fg("dim", " as autocomplete opens/closes.")) + th.fg("border", "│"));

		// Blank line
		lines.push(th.fg("border", "│") + pad("") + th.fg("border", "│"));

		// Bottom border
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}
