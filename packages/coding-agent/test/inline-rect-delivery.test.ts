import assert from "node:assert";
import type { Component, SurfaceRect } from "@earendil-works/pi-tui";
import { Container, TUI } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class TextLine implements Component {
	private text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

async function flush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

function makeMessage(customType: string): CustomMessage<unknown> {
	return {
		role: "custom",
		customType,
		content: "test",
		details: undefined,
		display: true,
		timestamp: Date.now(),
	} as CustomMessage<unknown>;
}

describe("Inline rect math", () => {
	it("computes screen rect from chat-container child offset and viewportTop", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const chatContainer = new Container();
		tui.addChild(chatContainer);

		const renderer: MessageRenderer = () => undefined;
		const cmc = new CustomMessageComponent(makeMessage("demo"), renderer, undefined, tui);
		cmc.addChild(new TextLine("MSG-LINE-1"));
		cmc.addChild(new TextLine("MSG-LINE-2"));
		chatContainer.addChild(cmc);

		tui.start();
		try {
			await flush(tui, terminal);

			const chatOffset = tui.getChildOffset(chatContainer);
			const childOffset = chatContainer.getChildOffset(cmc);
			assert.ok(chatOffset, "chatContainer offset must be recorded");
			assert.ok(childOffset, "child offset must be recorded");
			assert.ok(childOffset.lineCount >= 2, `expected lineCount >= 2, got ${childOffset.lineCount}`);

			// Simulate the rect-delivery math (the real driver runs via recurring afterNextRender;
			// here we exercise the math directly).
			const bufferTop = chatOffset.startLine + childOffset.startLine;
			const screenRow = bufferTop - tui.viewportTop;
			const visibleRows = Math.min(childOffset.lineCount, Math.max(0, 24 - screenRow));
			const computedRect: SurfaceRect = {
				row: screenRow,
				col: 0,
				rows: visibleRows,
				cols: terminal.columns,
			};
			// Content fits well within the viewport; expect full visibility starting at row 0.
			assert.strictEqual(screenRow, 0);
			assert.ok(visibleRows >= 2);
			assert.strictEqual(computedRect.col, 0);
			assert.strictEqual(computedRect.cols, 80);
			assert.strictEqual(computedRect.row, 0);
		} finally {
			tui.stop();
		}
	});
});
