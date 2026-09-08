import type { TextContent } from "@earendil-works/pi-ai";
import type { Component, SurfaceHandle, TUI } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { MessageRenderScope } from "./message-render-scope.ts";

/** Transcript ownership for resource-bearing custom messages. */
export class CustomMessageContainer extends Container {
	override removeChild(component: Component): void {
		const owned = this.children.includes(component);
		super.removeChild(component);
		if (owned && component instanceof CustomMessageComponent) component.dispose();
	}

	override clear(): void {
		const children = [...this.children];
		super.clear();
		for (const child of children) {
			if (child instanceof CustomMessageComponent) child.dispose();
		}
	}
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private readonly tui?: TUI;
	private attachment?: SurfaceHandle;
	private scope?: MessageRenderScope;
	private disposeComponent?: () => void;
	private dirty = true;
	private disposed = false;
	private lastOutput?: { width: number; lines: string[] };

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		tui?: TUI,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.tui = tui;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild(!tui);
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.refresh();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.refresh();
		}
	}

	override invalidate(): void {
		if (!this.disposed && (!this.tui || this.scope)) super.invalidate();
		else this.box.invalidate();
		this.refresh();
	}

	private refresh(): void {
		this.dirty = true;
		if (!this.disposed && (!this.tui || !this.customRenderer)) this.rebuild();
		this.tui?.requestRender();
	}

	override render(width: number): string[] {
		if (this.tui?.isRunning && !this.disposed && !this.attachment && this.customRenderer) {
			const attachment = this.tui.trackSurface(this);
			this.attachment = attachment;
			attachment.onRender((context) => {
				if (context.disposed) {
					this.attachment = undefined;
					this.releaseScope();
					this.dirty = true;
				} else if (this.dirty && !this.disposed && this.tui?.isRunning) {
					// Factories and cleanup run after text writes, including on restart.
					this.rebuild();
					this.tui.requestRender();
				}
			});
		}
		if (!this.disposed && this.tui?.isRunning && !this.scope && this.dirty && this.customRenderer) {
			if (this.lastOutput?.width === width) return [...this.lastOutput.lines];
			// Reserve only the message spacer until its first post-frame attachment.
			return [""];
		}
		if (this.disposed || (this.tui && (!this.tui.isRunning || !this.scope))) {
			if ((this.disposed || !this.tui?.isRunning) && this.lastOutput?.width === width) {
				return [...this.lastOutput.lines];
			}
			return ["", ...this.box.render(width)];
		}
		const lines = super.render(width);
		this.lastOutput = { width, lines: [...lines] };
		return lines;
	}

	/** Permanently release this message before removing it from the transcript. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.attachment) this.attachment.dispose();
		else this.releaseScope();
	}

	private releaseScope(): void {
		const scope = this.scope;
		const disposeComponent = this.disposeComponent;
		this.scope = undefined;
		this.disposeComponent = undefined;
		scope?.dispose();
		try {
			disposeComponent?.();
		} catch {
			// Component cleanup must not interrupt transcript replacement or terminal shutdown.
		}
	}

	private rebuild(useCustomRenderer = true): void {
		this.releaseScope();
		this.dirty = !useCustomRenderer;
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer && useCustomRenderer) {
			const scope = this.tui ? new MessageRenderScope(this.tui) : undefined;
			this.scope = scope;
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad, ...(scope ? { ui: scope } : {}) },
					theme,
				);
				if (component) {
					if (this.disposed) {
						component.dispose?.();
					} else {
						this.disposeComponent = () => component.dispose?.();
					}
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
			this.releaseScope();
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
