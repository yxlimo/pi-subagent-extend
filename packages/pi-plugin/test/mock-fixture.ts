// Fixture 的唯一装载入口：文件和内联对象都走同一套校验，报错里带上来源。
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateMockFixture } from "./mock-llm.ts";
import type { MockFixture } from "./mock-llm.ts";

export function loadMockFixture(path: string): MockFixture;
export function loadMockFixture(value: unknown): MockFixture;
export function loadMockFixture(source: unknown): MockFixture {
	if (typeof source === "string") {
		const text = readFileSync(source, "utf8");
		let parsed: unknown;
		try {
			parsed = parse(text);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${source}: invalid YAML: ${detail}`);
		}
		return validateMockFixture(parsed, source);
	}
	return validateMockFixture(source, "inline fixture");
}
