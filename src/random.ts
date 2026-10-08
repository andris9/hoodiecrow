/**
 * Seeded random numbers, so that randomized test behavior (UID shuffles, script rule chances) can be repeated
 */

/**
 * A small seeded random number generator (mulberry32), for repeatable "shuffle" orders
 *
 * @param {Number} seed Seed
 * @return {Function} returns numbers from 0 (inclusive) to 1 (exclusive)
 */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
