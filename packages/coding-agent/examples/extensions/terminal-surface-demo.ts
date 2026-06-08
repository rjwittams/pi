/**
 * Terminal Surface Demo
 *
 * A bordered Pi overlay that draws a Kitty image inside an inner viewport
 * and exercises Pi's structured pointer-event API: click-to-focus,
 * click-to-mark with cell→pixel mapping, and arrow-key navigation while
 * focused. Esc is host-enforced and returns focus to the composer; the
 * demo never sees Esc.
 *
 * Usage:
 *   pi --extension packages/coding-agent/examples/extensions/terminal-surface-demo.ts
 *   /terminal-surface-demo
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type PointerEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const ESC = "\x1b";
const ST = "\x1b\\";
const IMAGE_ID_BASE = 424200;
const PLACEMENT_ID_BASE = 424201;
const IMAGE_WIDTH = 192;
const IMAGE_HEIGHT = 128;

const PANEL_WIDTH = 56;
const PANEL_MARGIN = 1;
const PANEL_MAX_HEIGHT = "90%" as const;

const IMAGE_VIEWPORT = {
	cols: 36,
	rows: 12,
	rowOffset: 3,
	colOffset: 4,
	insetRow: 1,
	insetCol: 1,
} as const;

let activeClose: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("terminal-surface-demo", {
		description: "Show a bordered overlay panel with a Kitty image; exercises pointer events and click-to-focus",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (activeClose) {
				activeClose();
				return;
			}

			let component: TerminalSurfaceDemoComponent | undefined;
			let rectUnsubscribe: (() => void) | undefined;
			let pointerUnsubscribe: (() => void) | undefined;
			const inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "ctrl+g")) {
					activeClose?.();
					return { consume: true };
				}
				return undefined;
			});

			const surfacePromise = ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					activeClose = done;
					component = new TerminalSurfaceDemoComponent(tui, theme);
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: PANEL_WIDTH,
						maxHeight: PANEL_MAX_HEIGHT,
						margin: PANEL_MARGIN,
						nonCapturing: true,
					},
					onHandle: (handle: OverlayHandle) => {
						rectUnsubscribe = handle.onRectChange((rect) => component?.setOverlayRect(rect));
						pointerUnsubscribe = handle.onPointer((event) => component?.onPointer(event, handle));
					},
				},
			);

			void surfacePromise
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Terminal surface demo failed: ${message}`, "error");
				})
				.finally(() => {
					activeClose = undefined;
					inputUnsubscribe();
					rectUnsubscribe?.();
					pointerUnsubscribe?.();
				});
		},
	});
}

class TerminalSurfaceDemoComponent {
	readonly width = PANEL_WIDTH;
	focused = false;
	private readonly imageId = IMAGE_ID_BASE + Math.floor(Math.random() * 1000);
	private readonly placementId = PLACEMENT_ID_BASE + Math.floor(Math.random() * 1000);
	private overlayRect: { row: number; col: number; rows: number; cols: number } | undefined;
	private drawScheduled = false;
	private markerRow = Math.floor(IMAGE_VIEWPORT.rows / 2);
	private markerCol = Math.floor(IMAGE_VIEWPORT.cols / 2);
	private lastPixel: { x: number; y: number } | undefined;
	private readonly tui: {
		writeRaw(data: string): void;
		afterNextRender(callback: () => void): void;
		requestRender(): void;
	};
	private readonly theme: Theme;

	constructor(
		tui: {
			writeRaw(data: string): void;
			afterNextRender(callback: () => void): void;
			requestRender(): void;
		},
		theme: Theme,
	) {
		this.tui = tui;
		this.theme = theme;
	}

	setOverlayRect(rect: { row: number; col: number; rows: number; cols: number } | undefined): void {
		this.overlayRect = rect;
		if (!rect) {
			this.tui.writeRaw(deletePlacement(this.imageId, this.placementId));
			return;
		}
		this.scheduleDraw();
	}

	render(_width: number): string[] {
		const w = this.width;
		const innerW = w - 2;
		const lines: string[] = [];
		const th = this.theme;

		const pad = (s: string, len: number) => {
			const truncated = truncateToWidth(s, len, "…");
			return truncated + " ".repeat(Math.max(0, len - visibleWidth(truncated)));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", "🖼️ Terminal Surface Demo")}`));
		lines.push(
			row(
				` ${th.fg("dim", `Click or drag inside box to mark; arrows move; Esc releases.${this.focused ? " [focused]" : ""}`)}`,
			),
		);

		for (let r = 0; r < IMAGE_VIEWPORT.rows + 2; r++) {
			const prefix = " ".repeat(IMAGE_VIEWPORT.colOffset);
			if (r === 0) {
				const box = th.fg("accent", `╭${"─".repeat(IMAGE_VIEWPORT.cols)}╮`);
				lines.push(row(prefix + box));
			} else if (r === IMAGE_VIEWPORT.rows + 1) {
				const box = th.fg("accent", `╰${"─".repeat(IMAGE_VIEWPORT.cols)}╯`);
				lines.push(row(prefix + box));
			} else {
				const innerRow = r - 1; // 0-based row inside the inner box (excluding the top border)
				let body = th.fg("accent", "│");
				for (let c = 0; c < IMAGE_VIEWPORT.cols; c++) {
					if (innerRow === this.markerRow && c === this.markerCol) {
						body += th.fg("accent", "●");
					} else {
						body += " ";
					}
				}
				body += th.fg("accent", "│");
				lines.push(row(prefix + body));
			}
		}

		const status = this.lastPixel
			? ` cell(${this.markerCol},${this.markerRow}) → px(${this.lastPixel.x},${this.lastPixel.y})`
			: ` (click inside the box)`;
		lines.push(row(` ${th.fg("dim", status)}`));
		lines.push(row(` ${th.fg("dim", "Ctrl+G closes; command toggles.")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.scheduleDraw();
		return lines;
	}

	invalidate(): void {}

	/** Arrow keys move the marker while focused. Esc is intercepted by Pi and never reaches us. */
	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const r = IMAGE_VIEWPORT.rows;
		const c = IMAGE_VIEWPORT.cols;
		if (matchesKey(data, "up")) this.markerRow = Math.max(0, this.markerRow - 1);
		else if (matchesKey(data, "down")) this.markerRow = Math.min(r - 1, this.markerRow + 1);
		else if (matchesKey(data, "left")) this.markerCol = Math.max(0, this.markerCol - 1);
		else if (matchesKey(data, "right")) this.markerCol = Math.min(c - 1, this.markerCol + 1);
		else return;
		this.recomputePixel();
		this.tui.requestRender();
	}

	onPointer(event: PointerEvent, _handle: OverlayHandle): void {
		// Accept pointerdown (initial click) and pointermove (drag — only delivered
		// while a button is held under ?1002h). Hover-motion (no buttons) is not
		// reported by v1's mouse-mode acquire and is a v2 follow-up.
		if (event.type !== "pointerdown" && event.type !== "pointermove") return;
		const imageRect = this.imageScreenRect();
		if (!imageRect) return;
		if (event.row < imageRect.row || event.row >= imageRect.row + imageRect.rows) return;
		if (event.col < imageRect.col || event.col >= imageRect.col + imageRect.cols) return;
		this.markerRow = event.row - imageRect.row;
		this.markerCol = event.col - imageRect.col;
		this.recomputePixel();
		this.tui.requestRender();
	}

	dispose(): void {
		this.tui.writeRaw(deletePlacement(this.imageId, this.placementId));
	}

	private recomputePixel(): void {
		this.lastPixel = {
			x: Math.floor(((this.markerCol + 0.5) / IMAGE_VIEWPORT.cols) * IMAGE_WIDTH),
			y: Math.floor(((this.markerRow + 0.5) / IMAGE_VIEWPORT.rows) * IMAGE_HEIGHT),
		};
	}

	private scheduleDraw(): void {
		if (this.drawScheduled) return;
		this.drawScheduled = true;
		this.tui.afterNextRender(() => {
			this.drawScheduled = false;
			this.drawImage();
		});
	}

	private imageScreenRect(): { row: number; col: number; rows: number; cols: number } | undefined {
		const rect = this.overlayRect;
		if (!rect || rect.rows < IMAGE_VIEWPORT.rowOffset + IMAGE_VIEWPORT.rows + 2 || rect.cols < PANEL_WIDTH) {
			return undefined;
		}
		return {
			row: rect.row + IMAGE_VIEWPORT.rowOffset + IMAGE_VIEWPORT.insetRow,
			col: rect.col + IMAGE_VIEWPORT.colOffset + IMAGE_VIEWPORT.insetCol + 1,
			rows: IMAGE_VIEWPORT.rows,
			cols: IMAGE_VIEWPORT.cols,
		};
	}

	private drawImage(): void {
		const imageRect = this.imageScreenRect();
		if (!imageRect) {
			this.tui.writeRaw(deletePlacement(this.imageId, this.placementId));
			return;
		}

		// Per Kitty graphics protocol §"Interaction with other terminal actions",
		// a CSI 2J clear destroys image data, not just placements. Pi's TUI emits
		// 2J on every fullRender(true) (resize, etc.), so any "uploaded once"
		// optimization here would silently break after the first resize. Always
		// re-transmit the image bytes alongside the place command.
		const row = imageRect.row + 1;
		const col = imageRect.col + 1;
		this.tui.writeRaw(
			transmitRgbaGradient(this.imageId) +
				cursorTo(row, col) +
				placeImage(this.imageId, this.placementId, IMAGE_VIEWPORT.cols, IMAGE_VIEWPORT.rows),
		);
	}
}

function apc(params: string, payload?: string): string {
	return `${ESC}_G${params}${payload ? `;${payload}` : ""}${ST}`;
}

function transmitRgbaGradient(imageId: number): string {
	const payload = buildGradientRgba(IMAGE_WIDTH, IMAGE_HEIGHT).toString("base64");
	return apc(`a=t,f=32,s=${IMAGE_WIDTH},v=${IMAGE_HEIGHT},i=${imageId},q=2`, payload);
}

function placeImage(imageId: number, placementId: number, cols: number, rows: number): string {
	return apc(`a=p,C=1,i=${imageId},p=${placementId},c=${cols},r=${rows},z=-1,q=2`);
}

function deletePlacement(imageId: number, placementId: number): string {
	// d=i (lowercase) deletes only the placement; image data stays cached so
	// the next placeImage works after a resize blip without re-uploading.
	return apc(`a=d,d=i,i=${imageId},p=${placementId},q=2`);
}

function cursorTo(row: number, col: number): string {
	return `${ESC}[${row};${col}H`;
}

function buildGradientRgba(width: number, height: number): Buffer {
	const out = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const fx = x / Math.max(1, width - 1);
			const fy = y / Math.max(1, height - 1);
			const wave = Math.sin(fx * Math.PI * 4) * 0.5 + 0.5;
			out[i + 0] = Math.round(255 * fx);
			out[i + 1] = Math.round(255 * fy);
			out[i + 2] = Math.round(255 * wave * (1 - fy * 0.35));
			out[i + 3] = 255;
		}
	}
	return out;
}
