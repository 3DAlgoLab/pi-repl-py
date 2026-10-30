/**
 * How a cell error reaches the model.
 *
 * Kept out of index.ts for the same reason as diagnostics.ts: the formatting is pure, and only
 * isolated here can its edge cases be tested without a live kernel.
 */

/** Traceback lines kept after the header line. */
export const ERROR_STACK_LINES = 10;

/**
 * Header plus traceback, kept at both ends.
 *
 * A Python traceback runs outermost frame first and innermost last, so a head-only cut deletes the
 * one frame worth reading. The header (`ename: evalue`) always leads; past the budget the head keeps
 * the call path, the tail keeps the frame that raised, and the marker counts what sits between them
 * so a trimmed stack can never be mistaken for the whole story.
 */
export function composeErrorLines(error: { name: string; message: string; stack: string[] }): string[] {
	const header = `${error.name}: ${error.message}`;
	// the bridge already emits the header as the first stack line for some errors; never repeat it
	const stack = error.stack[0]?.trim() === header ? error.stack.slice(1) : [...error.stack];
	if (stack.length <= ERROR_STACK_LINES) return [header, ...stack];
	const head = Math.floor(ERROR_STACK_LINES / 3);
	const tail = ERROR_STACK_LINES - head - 1; // one line goes to the marker
	const omitted = stack.length - head - tail;
	return [
		header,
		...stack.slice(0, head),
		`[... ${omitted} traceback lines omitted; the frame that raised is in the tail below ...]`,
		...stack.slice(stack.length - tail),
	];
}
