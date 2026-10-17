import { AppError, ErrorCodes } from '../../core/errors/taxonomy';

export type RequisiteKind = 'PREREQUISITE' | 'COREQUISITE' | 'CONCURRENT';

export interface RequisiteEdge {
  courseId: string;
  requiredCourseId: string;
  type: RequisiteKind;
}

/**
 * Prerequisite DAG validator (BSL-103 / INV-3).
 *
 * Requisite edges point from a course to the course it requires
 * (`CS201 → CS101`). Only PREREQUISITE/COREQUISITE/CONCURRENT edges participate
 * in the graph ordering; the graph must stay acyclic so a student can always
 * complete the curriculum.
 */
export function buildAdjacency(edges: RequisiteEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensure = (node: string) => {
    if (!adjacency.has(node)) adjacency.set(node, new Set());
  };
  for (const edge of edges) {
    ensure(edge.courseId);
    ensure(edge.requiredCourseId);
    adjacency.get(edge.courseId)!.add(edge.requiredCourseId);
  }
  return adjacency;
}

/** Kahn's algorithm on the reversed graph — returns courses with prerequisites first. */
export function topologicalOrder(nodes: string[], edges: RequisiteEdge[]): { order: string[]; cyclic: boolean } {
  // dependents.get(x) = courses that require x → x must appear before them.
  const dependents = new Map<string, Set<string>>();
  const ensure = (node: string) => {
    if (!dependents.has(node)) dependents.set(node, new Set());
  };
  for (const node of nodes) ensure(node);
  for (const edge of edges) {
    ensure(edge.courseId);
    ensure(edge.requiredCourseId);
    dependents.get(edge.requiredCourseId)!.add(edge.courseId);
  }

  const inDegree = new Map<string, number>();
  for (const node of dependents.keys()) inDegree.set(node, 0);
  for (const targets of dependents.values()) {
    for (const target of targets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const queue: string[] = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of [...(dependents.get(node) ?? [])].sort()) {
      const degree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  const cyclic = order.length !== dependents.size;
  return { order, cyclic };
}

/** DFS cycle extraction — returns one concrete cycle for diagnostics. */
export function findCycle(edges: RequisiteEdge[]): string[] | null {
  const adjacency = buildAdjacency(edges);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adjacency.keys()) color.set(node, WHITE);

  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const index = stack.indexOf(next);
        cycle = [...stack.slice(index), next];
        return true;
      }
      if (state === WHITE && visit(next)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  };

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) break;
  }
  return cycle;
}

/**
 * Validates a proposed requisite mutation against the full graph. Throws
 * DAG_SELF_REFERENCE for direct self-loops and DAG_CYCLE_DETECTED (with the
 * offending path) when the mutation would close a cycle.
 */
export function assertRequisiteGraphValid(allEdges: RequisiteEdge[], proposed: RequisiteEdge): void {
  if (proposed.courseId === proposed.requiredCourseId) {
    throw new AppError(ErrorCodes.DAG_SELF_REFERENCE, 'A course cannot require itself.', {
      meta: { courseId: proposed.courseId },
    });
  }
  const combined = [...allEdges, proposed];
  const cycle = findCycle(combined);
  if (cycle) {
    throw new AppError(ErrorCodes.DAG_CYCLE_DETECTED, `Adding this requisite would create a cycle: ${cycle.join(' → ')}`, {
      meta: { cycle },
    });
  }
}

/** For a curriculum: direct + transitive unlock counts per course. */
export function unlockCounts(nodes: string[], edges: RequisiteEdge[]): Map<string, number> {
  const dependents = new Map<string, Set<string>>();
  const ensure = (node: string) => {
    if (!dependents.has(node)) dependents.set(node, new Set());
    return dependents.get(node)!;
  };
  for (const node of nodes) ensure(node);
  for (const edge of edges) {
    ensure(edge.requiredCourseId).add(edge.courseId);
  }

  const counts = new Map<string, number>();
  for (const node of nodes) {
    const seen = new Set<string>();
    const queue = [...(dependents.get(node) ?? [])];
    while (queue.length > 0) {
      const dependent = queue.shift()!;
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(...(dependents.get(dependent) ?? []));
    }
    counts.set(node, seen.size);
  }
  return counts;
}
