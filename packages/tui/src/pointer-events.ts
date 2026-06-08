/**
 * Structured pointer event delivered to plugin handlers.
 *
 * Coordinates are in 0-based terminal cells (row, col).
 * Wheel events use deltaY: -1 for up, 1 for down.
 */
export interface PointerEvent {
	type: "pointerdown" | "pointermove" | "pointerup" | "wheel";
	row: number;
	col: number;
	button: number; // 0=left, 1=middle, 2=right, 3=none/move
	buttons: number; // bitmask: bit0=left, bit1=middle, bit2=right
	deltaX: number;
	deltaY: number;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

const SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse one SGR mouse sequence into a structured PointerEvent.
 * Returns undefined for any input that is not a complete SGR mouse sequence.
 *
 * SGR encoding (xterm):
 *   ESC [ < B ; X ; Y M    (press / motion)
 *   ESC [ < B ; X ; Y m    (release of B's button)
 *   X, Y are 1-based cell coords; we convert to 0-based.
 *   B encodes button + modifiers + wheel + motion as a bitmask.
 */
export function parsePointerEvent(data: string): PointerEvent | undefined {
	const match = SGR_RE.exec(data);
	if (!match) return undefined;

	const b = parseInt(match[1]!, 10);
	const x = parseInt(match[2]!, 10);
	const y = parseInt(match[3]!, 10);
	const finalChar = match[4]!;

	const isMotion = (b & 32) !== 0;
	const isWheel = (b & 64) !== 0;
	const buttonBits = b & 3;
	const shiftKey = (b & 4) !== 0;
	const altKey = (b & 8) !== 0;
	const ctrlKey = (b & 16) !== 0;

	let type: PointerEvent["type"];
	let button: number;
	let buttons: number;
	let deltaX = 0;
	let deltaY = 0;

	if (isWheel) {
		type = "wheel";
		button = 3;
		buttons = 0;
		// Wheel buttons: 64=up, 65=down, 66=left, 67=right
		const wheelDir = b & 3;
		if (wheelDir === 0) deltaY = -1;
		else if (wheelDir === 1) deltaY = 1;
		else if (wheelDir === 2) deltaX = -1;
		else if (wheelDir === 3) deltaX = 1;
	} else if (isMotion) {
		type = "pointermove";
		// Motion-with-button-held: buttonBits indicates which button is held.
		// Motion-with-no-button (button code 35 = 32+3): buttonBits=3, no buttons held.
		if (buttonBits === 3) {
			button = 3;
			buttons = 0;
		} else {
			button = buttonBits;
			buttons = 1 << buttonBits;
		}
	} else if (finalChar === "m") {
		type = "pointerup";
		button = buttonBits;
		buttons = 0;
	} else {
		type = "pointerdown";
		button = buttonBits;
		buttons = 1 << buttonBits;
	}

	return {
		type,
		row: y - 1,
		col: x - 1,
		button,
		buttons,
		deltaX,
		deltaY,
		shiftKey,
		altKey,
		ctrlKey,
		metaKey: false,
	};
}
