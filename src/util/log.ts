/**
 * Console output.
 *
 * Deliberately ASCII-only. The Windows console mangles box-drawing characters
 * and ellipses into mojibake, and a tool that prints unreadable logs is worse
 * than one that prints plain ones.
 */

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(code: string): (text: string) => string {
	return (text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);
}

export const colour = {
	bold: wrap('1'),
	dim: wrap('2'),
	red: wrap('31'),
	green: wrap('32'),
	yellow: wrap('33'),
	blue: wrap('34'),
	cyan: wrap('36'),
};

export const log = {
	head(text: string): void {
		console.log(`\n${colour.bold(text)}`);
	},
	step(n: number, total: number, text: string): void {
		console.log(`${colour.dim(`[${n}/${total}]`)} ${text}`);
	},
	info(text: string): void {
		console.log(`  ${text}`);
	},
	dim(text: string): void {
		console.log(colour.dim(`  ${text}`));
	},
	ok(text: string): void {
		console.log(`${colour.green('[ok]')} ${text}`);
	},
	warn(text: string): void {
		console.log(`${colour.yellow('[warn]')} ${text}`);
	},
	err(text: string): void {
		console.error(`${colour.red('[error]')} ${text}`);
	},
	plain(text = ''): void {
		console.log(text);
	},
};
