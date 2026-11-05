import type { RegionSignal } from '@co/shared';
import { addDays } from '../domain/dates.js';
import type { Weather } from '../ports.js';

/** Approximate centre of each region, for rainfall lookups. */
export const REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'Addis Ababa': { lat: 9.03, lon: 38.74 },
  Afar: { lat: 11.79, lon: 41.0 },
  Amhara: { lat: 11.59, lon: 37.39 },
  'Benishangul-Gumuz': { lat: 10.07, lon: 34.53 },
  'Central Ethiopia': { lat: 7.55, lon: 37.85 },
  'Dire Dawa': { lat: 9.6, lon: 41.85 },
  Gambela: { lat: 8.25, lon: 34.59 },
  Harari: { lat: 9.31, lon: 42.12 },
  Oromia: { lat: 8.54, lon: 39.27 },
  Sidama: { lat: 6.85, lon: 38.4 },
  Somali: { lat: 9.35, lon: 42.8 },
  'South Ethiopia': { lat: 6.86, lon: 37.76 },
  'South West Ethiopia': { lat: 7.27, lon: 36.24 },
  Tigray: { lat: 13.5, lon: 39.47 },
};

type Fetch = typeof fetch;

async function dailySum(fetchImpl: Fetch, url: string): Promise<number> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const body = (await res.json()) as { daily?: { precipitation_sum?: Array<number | null> } };
  return (body.daily?.precipitation_sum ?? []).reduce<number>((s, v) => s + (v ?? 0), 0);
}

/**
 * Rainfall over the last 30 days compared with the same 30 days in the
 * previous three years, from the free Open-Meteo APIs (no key needed).
 * Results are cached per region per day.
 */
export class OpenMeteoWeather implements Weather {
  private cache = new Map<string, RegionSignal>();

  constructor(private fetchImpl: Fetch = fetch) {}

  async rainfall(region: string, today: string): Promise<RegionSignal | null> {
    const at = REGION_COORDS[region];
    if (!at) return null;
    const key = `${region}:${today}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const recent = await dailySum(
        this.fetchImpl,
        `https://api.open-meteo.com/v1/forecast?latitude=${at.lat}&longitude=${at.lon}&daily=precipitation_sum&past_days=30&forecast_days=0&timezone=UTC`,
      );
      const years = [1, 2, 3];
      const past = await Promise.all(
        years.map((y) => {
          const end = addDays(today, -365 * y);
          const start = addDays(end, -30);
          return dailySum(
            this.fetchImpl,
            `https://archive-api.open-meteo.com/v1/archive?latitude=${at.lat}&longitude=${at.lon}&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=UTC`,
          );
        }),
      );
      const normal = past.reduce((s, v) => s + v, 0) / past.length;
      const signal: RegionSignal = {
        region,
        recentMm: Math.round(recent * 10) / 10,
        normalMm: Math.round(normal * 10) / 10,
        // A dry season with little normal rain is not a shortfall.
        ratio: normal < 5 ? 1 : Math.round((recent / normal) * 100) / 100,
        asOf: today,
        source: 'open-meteo',
      };
      this.cache.set(key, signal);
      return signal;
    } catch {
      return null;
    }
  }
}

/** Fixed readings, for tests, demos and the simulator. */
export class FixedWeather implements Weather {
  constructor(private ratios: Record<string, number>) {}

  async rainfall(region: string, today: string): Promise<RegionSignal | null> {
    const ratio = this.ratios[region];
    if (ratio === undefined) return null;
    return { region, recentMm: Math.round(ratio * 100), normalMm: 100, ratio, asOf: today, source: 'demo' as const };
  }

  set(region: string, ratio: number) {
    this.ratios[region] = ratio;
  }
}

/**
 * Live readings, with labelled demo values for chosen regions so the demo
 * shows a dry spell whatever the real season is. The UI marks them "demo".
 */
export class DemoOverrideWeather implements Weather {
  constructor(
    private live: Weather,
    private overrides: Record<string, number>,
  ) {}

  async rainfall(region: string, today: string): Promise<RegionSignal | null> {
    const ratio = this.overrides[region];
    if (ratio !== undefined) return { region, recentMm: Math.round(ratio * 100), normalMm: 100, ratio, asOf: today, source: 'demo' };
    return this.live.rainfall(region, today);
  }
}
