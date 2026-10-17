import { describe, expect, it } from 'vitest';
import {
  assertRequisiteGraphValid,
  buildAdjacency,
  findCycle,
  topologicalOrder,
  unlockCounts,
  type RequisiteEdge,
} from '../../src/modules/academics/dag';
import { AppError, ErrorCodes } from '../../src/core/errors/taxonomy';

const edge = (courseId: string, requiredCourseId: string): RequisiteEdge => ({
  courseId,
  requiredCourseId,
  type: 'PREREQUISITE',
});

describe('curriculum DAG (INV-3)', () => {
  it('orders prerequisites before dependents', () => {
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('D', 'A')];
    const { order, cyclic } = topologicalOrder(['A', 'B', 'C', 'D'], edges);
    expect(cyclic).toBe(false);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('D'));
  });

  it('detects a cycle and findCycle returns the concrete path', () => {
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('A', 'C')];
    expect(topologicalOrder(['A', 'B', 'C'], edges).cyclic).toBe(true);
    const cycle = findCycle(edges);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('rejects self-requisites with DAG_SELF_REFERENCE', () => {
    try {
      assertRequisiteGraphValid([], edge('A', 'A'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.DAG_SELF_REFERENCE);
    }
  });

  it('rejects mutations that would close a cycle', () => {
    const existing = [edge('B', 'A'), edge('C', 'B')];
    try {
      assertRequisiteGraphValid(existing, edge('A', 'C'));
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.DAG_CYCLE_DETECTED);
      expect((error as AppError).meta.cycle).toBeDefined();
    }
  });

  it('computes transitive unlock counts', () => {
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('D', 'C')];
    const counts = unlockCounts(['A', 'B', 'C', 'D'], edges);
    expect(counts.get('A')).toBe(3);
    expect(counts.get('B')).toBe(2);
    expect(counts.get('D')).toBe(0);
  });

  it('keeps adjacency deduplicated', () => {
    const adjacency = buildAdjacency([edge('B', 'A'), edge('B', 'A')]);
    expect(adjacency.get('B')!.size).toBe(1);
  });
});
