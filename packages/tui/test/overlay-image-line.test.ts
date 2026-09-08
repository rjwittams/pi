import assert from "node:assert/strict";
import { it } from "node:test";
import { emitImageRow, splitImageRow } from "../src/image-row.ts";
import {
	encodeKitty,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { CURSOR_MARKER, compositeTuiLine } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

it("draws overlay borders on an image command row without dropping or duplicating the image", async () => {
	const image = "\x1b_Ga=T,f=100,C=1,i=42,m=1;AAAA\x1b\\\x1b_Gm=0;BBBB\x1b\\";
	const base = `  ${image}underlying text`;
	const row = splitImageRow(base);
	const first = compositeTuiLine(row.text, "│game│", 5, 6, 30);
	const second = emitImageRow(compositeTuiLine(first, "╭──╮", 0, 4, 30), row.images);
	assert.ok(second.includes(image));
	assert.equal(second.split(image).length, 2);
	const terminal = new VirtualTerminal(30, 4);
	terminal.write(second);
	await terminal.flush();
	assert.equal(terminal.getViewport()[0].slice(0, 11), "╭──╮d│game│");
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name}: tracks every image sharing a composed row`, async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		registerKittyImageMetadata({ imageId: 4001, widthPx: 20, heightPx: 10, columns: 2, rows: 1 });
		// This image exceeds the fullscreen offscreen cache budget and must be
		// freed on removal, while the first image on its row remains visible.
		registerKittyImageMetadata({ imageId: 4002, widthPx: 5000, heightPx: 5000, columns: 2, rows: 1 });
		const terminal = new RecordingTerminal(30, 8);
		const tui = new Renderer(terminal);
		const base = encodeKitty("AAAA", { imageId: 4001, columns: 2, rows: 1, moveCursor: false });
		const payload = "BBBB".repeat(1500);
		const overlayImage = encodeKitty(payload, { imageId: 4002, columns: 2, rows: 1, moveCursor: false });
		let text = "old";
		tui.addChild({ render: () => [base], invalidate: () => {} });
		const overlay = tui.showOverlay(
			{ render: () => [overlayImage], invalidate: () => {} },
			{ row: 0, col: 5, width: 2 },
		);
		tui.showOverlay({ render: () => [text], invalidate: () => {} }, { row: 0, col: 15, width: 5 });
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			assert.ok(terminal.writes.join("").includes(overlayImage));
			terminal.writes = [];
			text = "new";
			tui.renderNow();
			await terminal.flush();
			const repaint = terminal.writes.join("");
			assert.ok(!repaint.includes("AAAA") && !repaint.includes("BBBB"));
			assert.match(repaint, /a=p,[^\x1b]*i=4001/);
			assert.match(repaint, /a=p,[^\x1b]*i=4002/);
			terminal.writes = [];
			overlay.hide();
			tui.renderNow();
			await terminal.flush();
			assert.ok(terminal.writes.join("").includes("a=d,d=I,i=4002,"));
			assert.ok(!terminal.writes.join("").includes("a=d,d=I,i=4001,"));
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
	it(`${Renderer.name}: editing overlay text retains uploaded image data`, async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		registerKittyImageMetadata({ imageId: 12345, widthPx: 20, heightPx: 10, columns: 2, rows: 1 });
		const terminal = new RecordingTerminal(30, 8);
		const tui = new Renderer(terminal);
		const image = encodeKitty("AAAA", { imageId: 12345, columns: 2, rows: 1, moveCursor: false });
		let text = "old";
		tui.addChild({ render: () => [image], invalidate: () => {} });
		tui.showOverlay({ render: () => [text], invalidate: () => {} }, { row: 0, col: 5, width: 6 });
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			terminal.writes = [];
			text = "new";
			tui.renderNow();
			await terminal.flush();
			assert.equal(terminal.getViewport()[0].slice(5, 8), "new");
			assert.ok(!terminal.writes.join("").includes("AAAA"));
			assert.ok(!terminal.writes.join("").includes("d=I,i=12345"));
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
	it(`${Renderer.name}: input overlay cursor uses composed text columns`, async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new Renderer(terminal, true);
		tui.addChild({ render: () => ["\x1b_Ga=T,f=100,C=1,i=42;AAAA\x1b\\"], invalidate: () => {} });
		tui.showOverlay({ render: () => [`X${CURSOR_MARKER}Y`], invalidate: () => {} }, { row: 0, col: 5, width: 4 });
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			assert.equal(terminal.getViewport()[0].slice(5, 7), "XY");
			assert.deepEqual(terminal.getCursorPosition(), { x: 6, y: 0 });
		} finally {
			tui.stop();
		}
	});
	it(`${Renderer.name}: overlay border survives an image-row redraw`, async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new Renderer(terminal);
		let payload = "AAAA";
		tui.addChild({ render: () => [`\x1b_Ga=T,f=100,C=1,i=42;${payload}\x1b\\`], invalidate: () => {} });
		tui.showOverlay(
			{ render: () => ["╭────╮", "│game│", "╰────╯"], invalidate: () => {} },
			{ row: 0, col: 5, width: 6, nonCapturing: true },
		);
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			assert.equal(terminal.getViewport()[0].slice(5, 11), "╭────╮");
			payload = "BBBB";
			tui.renderNow();
			await terminal.flush();
			assert.equal(terminal.getViewport()[0].slice(5, 11), "╭────╮");
		} finally {
			tui.stop();
		}
	});
}

it("fullscreen selection copies the visible overlay text on an image row", async () => {
	const terminal = new VirtualTerminal(30, 8);
	let copied = "";
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied = text;
			return true;
		},
	});
	tui.addChild({ render: () => ["\x1b_Ga=T,f=100,C=1,i=42;AAAA\x1b\\"], invalidate: () => {} });
	tui.showOverlay({ render: () => ["ABCDEF"], invalidate: () => {} }, { row: 0, col: 5, width: 6 });
	tui.start();
	try {
		tui.renderNow();
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;8;1m");
		assert.equal(await tui.copyActiveSelectionToClipboard(), true);
		assert.equal(copied, "ABC");
	} finally {
		tui.stop();
	}
});
