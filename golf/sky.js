// The course's seed picks its time of day and weather (the same for all three holes, and for every golfer that day).
// Weighted toward fair days: rain and fog are rare. `over` (for testing) may name a time or weather to use instead.
import { TIMES, WEATHER } from './diorama.js';

export function courseSky(courseId, over = {}) {
  let h = 2166136261; for (const ch of `${courseId}:sky`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const pick = (table, u) => { let a = 0; for (const [k, w] of table) { a += w; if (u < a) return k; } return table[0][0]; };
  const u1 = (h % 1000) / 1000, u2 = ((h >>> 10) % 1000) / 1000;
  return {
    time: TIMES[over.time] ? over.time : pick([['noon', 0.4], ['morning', 0.25], ['sunset', 0.25], ['evening', 0.1]], u1),
    weather: WEATHER[over.weather] ? over.weather : pick([['clear', 0.45], ['hazy', 0.2], ['cloudy', 0.2], ['rainy', 0.08], ['foggy', 0.07]], u2),
  };
}
