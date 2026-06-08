import type { TextContent } from "@earendil-works/pi-ai";
import type { Component, Focusable, MessageHandle, PointerEvent, SurfaceRect, TUI } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

type MessagePointerListenerEntry = {
	listener: (event: PointerEvent) => void;
	wheel: boolean;
	hover: boolean;
};

/**
 * Concrete `MessageHandle` instance owned by a `CustomMessageComponent`. State
 * (rect listeners, pointer listeners, focus methods) lives here; rect updates
 * and pointer dispatch are driven by the chat layer (interactive-mode) and TUI.
 */
class MessageHandleImpl implements MessageHandle {
	lastRect: SurfaceRect | undefined = undefined;
	rectListeners = new Set<(rect: SurfaceRect | undefined) => void>();
	pointerListeners = new Set<MessagePointerListenerEntry>();
	private focusHook: { focus: () => void; unfocus: () => void; isFocused: () => boolean };
	private tui: TUI | undefined;
	private mouseModeRelease: (() => void) | undefined;

	constructor(tui: TUI | undefined, focusHook: { focus: () => void; unfocus: () => void; isFocused: () => boolean }) {
		this.tui = tui;
		this.focusHook = focusHook;
	}

	getRect(): SurfaceRect | undefined {
		return this.lastRect;
	}

	onRectChange(listener: (rect: SurfaceRect | undefined) => void): () => void {
		this.rectListeners.add(listener);
		listener(this.lastRect);
		return () => {
			this.rectListeners.delete(listener);
		};
	}

	onPointer(listener: (event: PointerEvent) => void, options?: { wheel?: boolean; hover?: boolean }): () => void {
		const entry: MessagePointerListenerEntry = {
			listener,
			wheel: options?.wheel === true,
			hover: options?.hover === true,
		};
		this.pointerListeners.add(entry);
		if (this.pointerListeners.size === 1 && this.tui) {
			this.mouseModeRelease = this.tui.acquireMouseMode();
		}
		return () => {
			if (!this.pointerListeners.has(entry)) return;
			this.pointerListeners.delete(entry);
			if (this.pointerListeners.size === 0 && this.mouseModeRelease) {
				this.mouseModeRelease();
				this.mouseModeRelease = undefined;
			}
		};
	}

	focus(): void {
		this.focusHook.focus();
	}

	unfocus(): void {
		this.focusHook.unfocus();
	}

	isFocused(): boolean {
		return this.focusHook.isFocused();
	}
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container implements Focusable {
	focused = false;
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private readonly tui?: TUI;
	readonly messageHandle: MessageHandleImpl;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		tui?: TUI,
	) {
		super();
		this.tui = tui;
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		this.messageHandle = new MessageHandleImpl(this.tui, {
			focus: () => {
				this.tui?.setPluginFocus(this);
			},
			unfocus: () => {
				if (this.tui && this.focused) {
					this.tui.setFocus(null);
				}
			},
			isFocused: () => this.focused,
		});

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	handleInput(data: string): void {
		const cc = this.customComponent;
		if (cc && "handleInput" in cc && typeof (cc as { handleInput?: unknown }).handleInput === "function") {
			(cc as { handleInput: (data: string) => void }).handleInput(data);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, tui: this.tui, handle: this.messageHandle },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
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
