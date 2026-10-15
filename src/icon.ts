import { addIcon } from "obsidian";

/** The Claude Studio mark: an uneven eight-ray burst, drawn to stay legible at 16px. */
export const ICON = "claude-studio";

export function registerIcon() {
  addIcon(ICON, '<path d="M50.0 35.0L50.0 6.0M61.7 40.6L73.3 31.1M65.0 49.0L89.9 47.2M59.6 61.5L69.9 73.7M50.8 65.0L52.3 92.9M38.2 59.2L27.1 67.9M35.1 51.3L11.1 53.4M40.0 38.9L28.6 26.2" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>');
}
