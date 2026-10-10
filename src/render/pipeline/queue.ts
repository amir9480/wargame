// Build jobs of the render pipeline, run a few per frame within a time budget so the page stays responsive
// while a map streams in.

import type * as THREE from 'three';
import { profiler } from '../../core/profiler.ts';

export interface Job {
  /** Lower ranks run first (render stage order). */
  rank: number;
  /** Within a rank, jobs nearest the camera focus run first; jobs without a position keep their queue order. */
  at?: THREE.Vector3;
  run(): void;
}

export class JobQueue {
  private jobs = new Map<string, Job>();

  /** Queues a job; a pending job with the same key is replaced (keeps its place in the queue). */
  add(key: string, job: Job): void {
    this.jobs.set(key, job);
  }

  get size(): number {
    return this.jobs.size;
  }

  clear(): void {
    this.jobs.clear();
  }

  /** Runs jobs until `budgetMs` is used up (at least one). Returns how many ran. */
  run(budgetMs: number, focus: THREE.Vector3): number {
    const t0 = performance.now();
    let ran = 0;
    while (this.jobs.size && (ran === 0 || performance.now() - t0 < budgetMs)) {
      const key = this.next(focus);
      const job = this.jobs.get(key)!;
      this.jobs.delete(key); // first: a job may queue follow-ups under its own key
      // Profiled per kind of job: `ground:12` -> build/ground.
      const t = profiler.begin('build', `job ${key.split(':')[0]}`);
      job.run();
      profiler.end(t);
      ran++;
    }
    return ran;
  }

  private next(focus: THREE.Vector3): string {
    let best = '';
    let bestRank = Infinity;
    let bestDist = Infinity;
    for (const [key, job] of this.jobs) {
      const dist = job.at ? job.at.distanceToSquared(focus) : 0;
      if (job.rank < bestRank || (job.rank === bestRank && dist < bestDist)) {
        best = key;
        bestRank = job.rank;
        bestDist = dist;
      }
    }
    return best;
  }
}
