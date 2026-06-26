export const DASHBOARD_REFRESH_DEFAULT_MAX_HISTORICAL_TURNS = 25;
export const DASHBOARD_REFRESH_MAX_HISTORICAL_TURNS = 120;

export function normalizeRefreshMaxHistoricalTurns(value) {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DASHBOARD_REFRESH_DEFAULT_MAX_HISTORICAL_TURNS;
  }
  return Math.min(
    DASHBOARD_REFRESH_MAX_HISTORICAL_TURNS,
    Math.max(1, Math.floor(parsed)),
  );
}
