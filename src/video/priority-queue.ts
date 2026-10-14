import type { VideoJobPriority } from "./types.js";

export interface QueueItem {
  jobId: string;
  priority: VideoJobPriority;
  sequence: number;
}

const priorityWeight: Record<VideoJobPriority, number> = { HIGH: 3, NORMAL: 2, LOW: 1 };

/** Small in-process queue: intentional for the single-machine MCP deployment. */
export class PriorityJobQueue {
  private items: QueueItem[] = [];
  private sequence = 0;

  enqueue(jobId: string, priority: VideoJobPriority): void {
    if (this.items.some((item) => item.jobId === jobId)) return;
    this.items.push({ jobId, priority, sequence: this.sequence++ });
    this.items.sort((left, right) => {
      const priorityDiff = priorityWeight[right.priority] - priorityWeight[left.priority];
      return priorityDiff || left.sequence - right.sequence;
    });
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  remove(jobId: string): void {
    this.items = this.items.filter((item) => item.jobId !== jobId);
  }

  get size(): number {
    return this.items.length;
  }
}
