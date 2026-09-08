/**
 * Generic Kitty graphics surface, ported from the original terminal-surface branch.
 * /terminal-surface-demo toggles a floating panel; append "inline" for a message.
 * Drag the title to move, borders to resize, or image to move the marker.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	deleteKittyImage,
	getKeybindings,
	isKeyRelease,
	type OverlayHandle,
	type SurfaceGeometry,
	type SurfaceHandle,
	type SurfaceRect,
	type SurfaceRenderContext,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const IMAGE_WIDTH = 192;
const IMAGE_HEIGHT = 128;
const PANEL_WIDTH = 56;
const PANEL_HEIGHT = 20;
const IMAGE_X = 4;
const IMAGE_Y = 4;

type Drag = {
	x: number;
	y: number;
	bounds: SurfaceRect;
	edges?: { left: boolean; right: boolean; top: boolean; bottom: boolean };
};

export default function (pi: ExtensionAPI) {
	let closeActive: (() => void) | undefined;
	pi.registerCommand("terminal-surface-demo", {
		description: "Toggle a draggable Kitty graphics panel; pass 'inline' for a message",
		handler: async (args, ctx) => {
			if (args.trim() === "inline") {
				pi.sendMessage({
					customType: "terminal-surface-demo-inline",
					content: "Terminal surface demo",
					display: true,
				});
				return;
			}
			if (closeActive) {
				closeActive();
				return;
			}
			let panel: SurfaceLabContent | undefined;
			const unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (getKeybindings().matches(data, "tui.surface.releaseFocus")) {
					closeActive?.();
					return { consume: true };
				}
				return undefined;
			});
			void ctx.ui
				.custom<void>(
					(tui, theme, _keys, done) => {
						closeActive = done;
						panel = new SurfaceLabContent(theme, done);
						panel.attachSurface(tui.trackSurface(panel, { mouse: true }));
						return panel;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: PANEL_WIDTH,
							height: PANEL_HEIGHT,
							maxHeight: "90%",
							margin: 1,
							nonCapturing: true,
						},
						onHandle: (handle) => panel?.attachOverlay(handle),
					},
				)
				.catch((error: unknown) => {
					// Host shutdown/reload also disposes the component before rejecting.
					if (!panel?.disposed) ctx.ui.notify(String(error), "error");
				})
				.finally(() => {
					closeActive = undefined;
					unsubscribe();
				});
		},
	});
	pi.registerMessageRenderer("terminal-surface-demo-inline", (_message, options, theme) => {
		if (!options.ui) return undefined;
		const panel = new SurfaceLabContent(theme);
		panel.attachSurface(options.ui.trackSurface(panel, { mouse: true }));
		return panel;
	});
}

export class SurfaceLabContent {
	focused = false;
	disposed = false;
	private readonly theme: Theme;
	private readonly close: (() => void) | undefined;
	private readonly imageId = allocateImageId();
	private readonly upload: string;
	private surface: SurfaceHandle | undefined;
	private overlay: OverlayHandle | undefined;
	private geometry: SurfaceGeometry | undefined;
	private panelHeight = PANEL_HEIGHT;
	private renderedWidth = PANEL_WIDTH;
	private renderedHeight = PANEL_HEIGHT;
	private markerX = 0;
	private markerY = 0;
	private drag: Drag | undefined;
	private marking = false;
	private uploaded = false;
	private revision = -1;

	constructor(theme: Theme, close?: () => void) {
		this.theme = theme;
		this.close = close;
		this.upload = transmitGradient(this.imageId);
	}

	attachOverlay(overlay: OverlayHandle): void {
		this.overlay = overlay;
	}

	attachSurface(surface: SurfaceHandle): void {
		this.surface = surface;
		surface.onGeometryChange((geometry) => {
			this.geometry = geometry;
			// render(width) has no height argument. Reflow chrome after the host
			// commits a clamped allocation; inline messages keep their natural height.
			if (this.close && geometry && geometry.bounds.height !== this.panelHeight) {
				this.panelHeight = geometry.bounds.height;
				surface.requestRender();
			}
		});
		surface.onRender((frame) => this.draw(frame));
	}

	render(width: number): string[] {
		this.renderedWidth = width;
		this.renderedHeight = this.panelHeight;
		const color = this.focused ? "accent" : "border";
		if (width < 6 || this.panelHeight < 9) return [truncateToWidth("Surface: enlarge terminal", width, "", true)];
		const inner = width - 2;
		const row = (text: string) =>
			this.theme.fg(color, "│") + truncateToWidth(text, inner, "…", true) + this.theme.fg(color, "│");
		const image = this.imageRect();
		this.clampMarker();
		const lines = [
			this.theme.fg(color, `╭${"─".repeat(inner - 1)}${this.close ? "×" : "─"}╮`),
			row(" Terminal Surface Demo"),
			row(this.close ? " Drag title / borders; click image" : " Click image to focus; arrow keys move marker"),
			row(`  ╭${"─".repeat(image.width)}╮`),
		];
		for (let y = 0; y < image.height; y++) {
			const body =
				y === this.markerY
					? `${" ".repeat(this.markerX)}●${" ".repeat(image.width - this.markerX - 1)}`
					: " ".repeat(image.width);
			lines.push(row(`  │${body}│`));
		}
		const px = Math.floor(((this.markerX + 0.5) / image.width) * IMAGE_WIDTH);
		const py = Math.floor(((this.markerY + 0.5) / image.height) * IMAGE_HEIGHT);
		lines.push(row(`  ╰${"─".repeat(image.width)}╯`));
		lines.push(row(` cell(${this.markerX},${this.markerY}) → px(${px},${py})`));
		const release = getKeybindings().getKeys("tui.surface.releaseFocus").join("/");
		lines.push(row(` ${release} ${this.close ? "closes" : "releases focus"}`));
		lines.push(this.theme.fg(color, `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const keys = getKeybindings();
		if (this.close && keys.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (keys.matches(data, "tui.editor.cursorUp")) this.markerY--;
		else if (keys.matches(data, "tui.editor.cursorDown")) this.markerY++;
		else if (keys.matches(data, "tui.editor.cursorLeft")) this.markerX--;
		else if (keys.matches(data, "tui.editor.cursorRight")) this.markerX++;
		else return;
		this.clampMarker();
		this.surface?.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "release") {
			this.handleMouseCancel();
			return { handled: true };
		}
		if (event.type === "drag" && this.drag && this.overlay) {
			const { bounds, edges } = this.drag;
			const dx = event.screenX - this.drag.x;
			const dy = event.screenY - this.drag.y;
			let { x, y, width, height } = bounds;
			if (!edges) {
				x += dx;
				y += dy;
			} else {
				if (edges.left) {
					width = Math.max(42, bounds.width - dx);
					x += bounds.width - width;
				}
				if (edges.right) width = Math.max(42, bounds.width + dx);
				if (edges.top) {
					height = Math.max(10, bounds.height - dy);
					y += bounds.height - height;
				}
				if (edges.bottom) height = Math.max(10, bounds.height + dy);
			}
			this.overlay.updateOptions({ row: y, col: x, width, height });
			return { handled: true, render: true };
		}
		if (event.type === "press" && event.button === "left") {
			const bounds = this.geometry?.bounds;
			if (this.overlay && bounds) {
				if (event.y === 0 && event.x === bounds.width - 2) {
					this.close?.();
					return { handled: true };
				}
				const edges = {
					left: event.x === 0,
					right: event.x === bounds.width - 1,
					top: event.y === 0,
					bottom: event.y === bounds.height - 1,
				};
				const resize = Object.values(edges).some(Boolean);
				if (resize || event.y === 1) {
					this.drag = {
						x: event.screenX,
						y: event.screenY,
						bounds: { ...bounds },
						edges: resize ? edges : undefined,
					};
					return { capture: true, focus: true };
				}
			}
			const image = this.imageRect();
			this.marking =
				event.x >= image.x &&
				event.x < image.x + image.width &&
				event.y >= image.y &&
				event.y < image.y + image.height;
			if (!this.marking) return { handled: true, focus: true };
		} else if (event.type !== "drag" || !this.marking) return undefined;
		this.markerX = event.x - IMAGE_X;
		this.markerY = event.y - IMAGE_Y;
		this.clampMarker();
		return { capture: true, focus: true, render: true };
	}

	handleMouseCancel(): void {
		this.drag = undefined;
		this.marking = false;
	}
	dispose(): void {
		this.disposed = true;
		this.handleMouseCancel();
		this.surface?.dispose();
	}

	private imageRect(): SurfaceRect {
		return {
			x: IMAGE_X,
			y: IMAGE_Y,
			width: Math.max(1, this.renderedWidth - 6),
			height: Math.max(1, this.renderedHeight - 8),
		};
	}
	private clampMarker(): void {
		const image = this.imageRect();
		this.markerX = Math.max(0, Math.min(image.width - 1, this.markerX));
		this.markerY = Math.max(0, Math.min(image.height - 1, this.markerY));
	}
	private draw(frame: SurfaceRenderContext): void {
		if (frame.disposed) {
			frame.write(deleteKittyImage(this.imageId));
			return;
		}
		if (frame.revision === this.revision) return;
		this.revision = frame.revision;
		if (frame.graphicsInvalidation === "images") this.uploaded = false;
		let output = apc(`a=d,d=i,i=${this.imageId},p=1,q=2`);
		const geometry = frame.geometry;
		if (!geometry || this.renderedWidth < 6 || this.renderedHeight < 9) {
			frame.write(output);
			return;
		}
		const image = this.imageRect();
		image.x += geometry.bounds.x;
		image.y += geometry.bounds.y - geometry.contentOffset;
		const x = Math.max(image.x, geometry.clip.x);
		const y = Math.max(image.y, geometry.clip.y);
		const width = Math.max(0, Math.min(image.x + image.width, geometry.clip.x + geometry.clip.width) - x);
		const height = Math.max(0, Math.min(image.y + image.height, geometry.clip.y + geometry.clip.height) - y);
		if (width && height) {
			if (!this.uploaded) output += this.upload;
			const sx = Math.floor(((x - image.x) / image.width) * IMAGE_WIDTH);
			const sy = Math.floor(((y - image.y) / image.height) * IMAGE_HEIGHT);
			const sw = Math.max(1, Math.ceil(((x + width - image.x) / image.width) * IMAGE_WIDTH) - sx);
			const sh = Math.max(1, Math.ceil(((y + height - image.y) / image.height) * IMAGE_HEIGHT) - sy);
			output += `\x1b[${y + 1};${x + 1}H${apc(`a=p,C=1,i=${this.imageId},p=1,c=${width},r=${height},x=${sx},y=${sy},w=${sw},h=${sh},z=-1,q=2`)}`;
			if (frame.write(output)) this.uploaded = true;
		} else frame.write(output);
	}
}

function apc(params: string, payload?: string): string {
	return `\x1b_G${params}${payload ? `;${payload}` : ""}\x1b\\`;
}

function transmitGradient(imageId: number): string {
	const rgba = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
	for (let y = 0; y < IMAGE_HEIGHT; y++) {
		for (let x = 0; x < IMAGE_WIDTH; x++) {
			const offset = (y * IMAGE_WIDTH + x) * 4;
			const fx = x / (IMAGE_WIDTH - 1);
			const fy = y / (IMAGE_HEIGHT - 1);
			rgba[offset] = Math.round(255 * fx);
			rgba[offset + 1] = Math.round(255 * fy);
			rgba[offset + 2] = Math.round(255 * (Math.sin(fx * Math.PI * 4) * 0.5 + 0.5) * (1 - fy * 0.35));
			rgba[offset + 3] = 255;
		}
	}
	const payload = rgba.toString("base64");
	const chunks: string[] = [];
	for (let offset = 0; offset < payload.length; offset += 4096) {
		const first = offset === 0 ? `a=t,f=32,s=${IMAGE_WIDTH},v=${IMAGE_HEIGHT},i=${imageId},q=2,` : "";
		chunks.push(apc(`${first}m=${offset + 4096 < payload.length ? 1 : 0}`, payload.slice(offset, offset + 4096)));
	}
	return chunks.join("");
}
