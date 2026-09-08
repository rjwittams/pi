import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Terminal extends VirtualTerminal {
	override write(data: string): void {
		super.write(data);
		if (data === "\x1b[6n") this.sendInput("\x1b[1;1R");
	}
}

class Panel implements Component {
	render(): string[] {
		return ["border", "body", "border"];
	}
	invalidate(): void {}
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name}: surface occlusion follows text stacking, movement and visibility`, () => {
		const tui = new Renderer(new Terminal(40, 16));
		const base = new Panel();
		const lower = new Panel();
		const upper = new Panel();
		const wrapper = new Container();
		wrapper.addChild(lower);
		tui.addChild(base);
		const baseHandle = tui.trackSurface(base);
		const lowerHandle = tui.trackSurface(lower);
		const upperHandle = tui.trackSurface(upper);
		let changes = 0;
		lowerHandle.onGeometryChange(() => changes++);
		tui.start();
		try {
			const a = tui.showOverlay(wrapper, { row: 1, col: 2, width: 12 });
			const b = tui.showOverlay(upper, { row: 2, col: 6, width: 10 });
			tui.renderNow();
			assert.deepEqual(lowerHandle.getGeometry()?.occlusions, [{ x: 6, y: 2, width: 8, height: 2 }]);
			assert.equal(upperHandle.getGeometry()?.occlusions, undefined);
			assert.equal(baseHandle.getGeometry()?.occlusions?.length, 2);
			const copy = lowerHandle.getGeometry()!;
			copy.occlusions![0].x = 999;
			assert.equal(lowerHandle.getGeometry()?.occlusions?.[0].x, 6);
			const count = changes;
			tui.renderNow();
			assert.equal(changes, count, "idle renders do not notify");
			b.updateOptions({ col: 8 });
			tui.renderNow();
			assert.equal(changes, count + 1, "coverage changes notify without moving the surface");
			a.focus();
			tui.renderNow();
			assert.equal(lowerHandle.getGeometry()?.occlusions, undefined);
			assert.deepEqual(upperHandle.getGeometry()?.occlusions, [{ x: 8, y: 2, width: 6, height: 2 }]);
			a.setHidden(true);
			tui.renderNow();
			assert.equal(lowerHandle.getGeometry(), undefined);
			assert.equal(upperHandle.getGeometry()?.occlusions, undefined);
			// Ordinary dialogs occlude surfaces even without a surface registration.
			const dialog = tui.showOverlay(new Panel(), { row: 2, col: 8, width: 10 });
			tui.renderNow();
			assert.deepEqual(upperHandle.getGeometry()?.occlusions, [upperHandle.getGeometry()!.clip]);
			dialog.hide();
			tui.renderNow();
			assert.equal(upperHandle.getGeometry()?.occlusions, undefined);
		} finally {
			tui.stop();
		}
	});
}
