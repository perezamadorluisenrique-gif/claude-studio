import { moment } from "obsidian";

/**
 * The part of moment the plugin uses, typed here: the directory's review has no
 * types for `moment` and reads every untyped call as unsafe.
 */
export interface Day {
  format(pattern?: string): string;
  subtract(amount: number, unit: "days"): Day;
  valueOf(): number;
  isSame(other: Day, unit: "day" | "month"): boolean;
  fromNow(): string;
  calendar(reference: null, formats: Record<string, string>): string;
}

export const clock = moment as unknown as (input?: number | string | Date) => Day;
