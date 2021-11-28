/**
 * Creates an interval that waits for the action
 * to complete before setting a new timer
 */
export function createAwaitingInterval(
	action: () => Promise<void>,
	interval: number
): {
	dispose: () => void;
} {
	let timer: NodeJS.Timeout | undefined;

	const setTimer = (): void => {
		timer = setTimeout(() => {
			void action().then(setTimer);
		}, interval);
	};

	setTimer();

	return {
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}

export interface Wither {
	setup: () => void;
	breakDown: () => void;
}

export async function runWith<R>(
	wither: Wither,
	fn: () => Promise<R> | R
): Promise<R> {
	wither.setup();
	const value = await fn();
	wither.breakDown();
	return value;
}

export function uniqueSimple<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

export function uniqueComplex<T>(arr: T[], key: (item: T) => string): T[] {
	const items: T[] = [];
	for (const item of arr) {
		const keyValue = key(item);
		const alreadyPushed = items.find((i) => key(i) === keyValue);
		if (!alreadyPushed) {
			items.push(item);
		}
	}
	return items;
}

export function decodeBase64(text: string): string {
	return Buffer.from(text, 'base64').toString('utf8');
}

/**
 * Equal to
 * ```ts
 * condition ? ifTrue ?? fallback : fallback
 * ```
 */
export function tertiaryWithFallback<V>(
	condition: boolean,
	ifTrue: V | null,
	fallback: V
): V {
	if (!condition) {
		return fallback;
	}
	return ifTrue ?? fallback;
}

export function optionalObjectProperty<
	O extends {
		[K: string]: V | undefined;
	},
	V
>(
	object: O
): {
	[K in keyof O]: O[K] extends undefined ? never : O[K];
} {
	const newObj: Partial<{
		[K in keyof O]: O[K] extends undefined ? never : O[K];
	}> = {};
	for (const key in object) {
		if (object[key] !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			newObj[key] = object[key] as any;
		}
	}
	return newObj as {
		[K in keyof O]: O[K] extends undefined ? never : O[K];
	};
}

export function toArray<V>(value: V | V[]): V[] {
	if (Array.isArray(value)) {
		return value;
	}
	return [value];
}

/**
 * Allows the use of
 * ```ts
 * var x = [
 *     ...optionalArrayEntry(true, [1,2]),
 *     3, 4
 * ];
 * ```
 * without the need to filter out undefined from the array
 * or something like that
 */

export function optionalArrayEntry<V>(
	condition: boolean,
	arr: V | V[] | (() => V[] | V)
): V[];
export function optionalArrayEntry<V>(
	condition: boolean,
	arr: () => Promise<V[] | V>
): Promise<V[]>;
export function optionalArrayEntry<V>(
	condition: boolean,
	arr: V | V[] | (() => V[] | V) | (() => Promise<V[] | V>)
): Promise<V[]> | V[] {
	if (condition) {
		if (typeof arr !== 'function') {
			return toArray(arr);
		}
		const result = (arr as (() => V[] | V) | (() => Promise<V[] | V>))();
		if (!('then' in result)) {
			return toArray(result);
		}
		return new Promise<V[]>((resolve, reject) => {
			result.then((value) => {
				resolve(toArray(value));
			}, reject);
		});
	}
	return [] as V[];
}
