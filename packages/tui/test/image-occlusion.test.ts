import assert from "node:assert/strict";
import { test } from "node:test";
import { occludeImageRow } from "../src/image-occlusion.ts";
import {
	cropKittyImageLine,
	encodeKitty,
	getKittyImagePlacement,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function image(id = 901): string {
	registerKittyImageMetadata({ imageId: id, widthPx: 100, heightPx: 80, columns: 10, rows: 4 });
	return encodeKitty("AAAA".repeat(1200), { imageId: id, columns: 10, rows: 4, moveCursor: false });
}
function placements(output: string): Record<string, number>[] {
	return [...output.matchAll(/\x1b_Ga=p,([^\x1b]*)\x1b\\/g)].map((match) =>
		Object.fromEntries(
			match[1].split(",").map((param) => {
				const [key, value] = param.split("=");
				return [key, Number(value)];
			}),
		),
	);
}

test("occlusion splits source pixels into four pieces and keeps one intact chunked upload", () => {
	const source = image();
	const result = occludeImageRow(source, 2, [{ x: 3, y: 3, width: 4, height: 2 }]);
	assert.ok(result.startsWith(source.replace("a=T", "a=t")));
	assert.deepEqual(
		placements(result).map(({ x, y, w, h, c, r }) => ({ x, y, w, h, c, r })),
		[
			{ x: 0, y: 0, w: 100, h: 20, c: 10, r: 1 },
			{ x: 0, y: 60, w: 100, h: 20, c: 10, r: 1 },
			{ x: 0, y: 20, w: 30, h: 40, c: 3, r: 2 },
			{ x: 70, y: 20, w: 30, h: 40, c: 3, r: 2 },
		],
	);
	const cached = getKittyImagePlacement(result)!;
	assert.equal(cached.sequence, "");
	assert.equal(cached.replacementLine.includes("AAAA"), false);
	assert.deepEqual(placements(cached.replacementLine), placements(result));
	assert.equal(occludeImageRow(source, 2, [{ x: 12, y: 2, width: 2, height: 2 }]), source);
});

test("full coverage emits only the upload; overlapping covers and clipped source offsets compose", () => {
	const source = image();
	const hidden = occludeImageRow(source, 0, [
		{ x: 0, y: 0, width: 6, height: 4 },
		{ x: 4, y: 0, width: 6, height: 4 },
	]);
	assert.deepEqual(placements(hidden), []);
	assert.equal(getKittyImagePlacement(hidden)?.replacementLine, "");
	const cropped = cropKittyImageLine(source, 1, 2);
	const result = occludeImageRow(`\x1b[6G${cropped}`, 0, [{ x: 5, y: 0, width: 3, height: 2 }]);
	assert.deepEqual(
		placements(result).map(({ x, y, w, h }) => ({ x, y, w, h })),
		[{ x: 30, y: 20, w: 70, h: 40 }],
	);
});

test("independent images on a row use their own anchors and metadata", () => {
	const first = image(902),
		second = image(903);
	const result = occludeImageRow(`${first}\x1b[21G${second}`, 0, [{ x: 2, y: 0, width: 23, height: 4 }]);
	assert.deepEqual(
		placements(result).map(({ i, x, w, c }) => ({ i, x, w, c })),
		[
			{ i: 902, x: 0, w: 20, c: 2 },
			{ i: 903, x: 50, w: 50, c: 5 },
		],
	);
});

class Terminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name}: an overlay image is covered only by overlays above it`, () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const source = image(911);
		const terminal = new Terminal(30, 10);
		const tui = new Renderer(terminal);
		const picture = tui.showOverlay(
			{ render: () => [source, "", "", ""], invalidate: () => {} },
			{ row: 0, col: 0, width: 10 },
		);
		tui.showOverlay({ render: () => ["border", "border"], invalidate: () => {} }, { row: 1, col: 3, width: 4 });
		tui.start();
		try {
			tui.renderNow();
			assert.equal(placements(terminal.writes.join("")).length, 4);
			terminal.writes = [];
			picture.focus();
			tui.renderNow();
			const visible = placements(terminal.writes.join(""));
			assert.equal(visible.length, 1);
			assert.equal(visible[0].c, 10);
			assert.equal(visible[0].r, 4);
			assert.ok(!terminal.writes.join("").includes("AAAA"));
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
	test(`${Renderer.name}: opening, moving, covering and closing an overlay reuses image data`, async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const source = image(910);
		const terminal = new Terminal(30, 10);
		const tui = new Renderer(terminal);
		tui.addChild({ render: () => [source, "", "", ""], invalidate: () => {} });
		tui.start();
		try {
			tui.renderNow();
			await terminal.flush();
			terminal.writes = [];
			const overlay = tui.showOverlay(
				{ render: () => ["╭──╮", "╰──╯"], invalidate: () => {} },
				{ row: 1, col: 3, width: 4 },
			);
			tui.renderNow();
			await terminal.flush();
			assert.equal(terminal.getViewport()[1].slice(3, 7), "╭──╮");
			assert.equal(placements(terminal.writes.join("")).length, 4);
			assert.ok(!terminal.writes.join("").includes("AAAA"));
			terminal.writes = [];
			overlay.updateOptions({ col: 0 });
			tui.renderNow();
			assert.equal(placements(terminal.writes.join("")).length, 3);
			assert.ok(!terminal.writes.join("").includes("AAAA"));
			terminal.writes = [];
			overlay.updateOptions({ row: 0, width: 10, height: 4 });
			tui.renderNow();
			assert.equal(placements(terminal.writes.join("")).length, 0);
			assert.ok(!terminal.writes.join("").includes("AAAA"));
			terminal.writes = [];
			overlay.hide();
			tui.renderNow();
			assert.equal(placements(terminal.writes.join("")).length, 1);
			assert.ok(!terminal.writes.join("").includes("AAAA"));
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
}
