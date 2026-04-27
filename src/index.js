import Worker from './worker.js';

export function createPool(handler) {
  const num = parseInt(process.env.NUM_WORKERS, 10);
  const NUM_WORKERS = Number.isInteger(num) && num > 0 ? num : 4;
  if (!Number.isInteger(NUM_WORKERS) || NUM_WORKERS <= 0) throw new Error('NUM_WORKERS must be a positive integer');
 
  const workers = Array.from({ length: NUM_WORKERS }, (_, i) => new Worker(i, handler));
  return { workers, NUM_WORKERS };
}
