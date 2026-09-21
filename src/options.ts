export interface DiffSettings {
  gitPath: string;
  showMarkers: boolean;
  fontSize: number;
  contextLines: number;
  inlineHighlights: boolean;
  showWhitespace: boolean;
  followEditor: boolean;
  followNavigation: boolean;
  editDelayMs: number;
  gitPollSeconds: number;
}

export const DEFAULT_SETTINGS: DiffSettings = {
  gitPath: 'git', showMarkers: true, fontSize: 13, contextLines: 3,
  inlineHighlights: true, showWhitespace: true, followEditor: true, followNavigation: true,
  editDelayMs: 350, gitPollSeconds: 5,
};

export const SETTING_LIMITS = {
  fontSize: [10, 22, 1], contextLines: [0, 10, 1], editDelayMs: [100, 2000, 50], gitPollSeconds: [2, 60, 1],
} as const;

export function normalizeSettings(value: unknown): DiffSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS };
  if (typeof input.gitPath === 'string' && input.gitPath.trim()) result.gitPath = input.gitPath.trim();
  for (const key of ['showMarkers', 'inlineHighlights', 'showWhitespace', 'followEditor', 'followNavigation'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of Object.keys(SETTING_LIMITS) as (keyof typeof SETTING_LIMITS)[]) {
    const number = input[key];
    const [min, max] = SETTING_LIMITS[key];
    if (typeof number === 'number' && Number.isFinite(number)) result[key] = Math.min(max, Math.max(min, Math.round(number)));
  }
  return result;
}
