"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";
import { StatusMark } from "@/components/ui/status-mark";
import { dayName, formatRange, formatTime } from "@/lib/format";
import {
  blockLayout,
  findConflicts,
  GRID_DAYS,
  gridRowCount,
  gridSlotLabels,
  type BlockState,
  type GridBlock,
} from "@/lib/grid";

const ROW_PX = 28;

const STATE_CLASSES: Record<BlockState, string> = {
  enrolled: "border border-ink bg-ink text-paper",
  candidate: "border border-ink bg-signal text-ink",
  waitlisted: "border border-ink bg-paper text-ink hatch",
  conflict: "border-2 border-stamp bg-surface text-stamp motion-safe:pulse-once",
  open: "border border-dashed border-ink-soft bg-transparent text-ink-soft",
};

interface WeekGridProps {
  blocks: GridBlock[];
  onSelect?: (block: GridBlock) => void;
  emptyLabel?: string;
}

export function WeekGrid({ blocks, onSelect, emptyLabel = "Nothing scheduled here yet." }: WeekGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const resolved = useMemo(() => {
    const conflicts = findConflicts(blocks);
    return blocks.map((block) => ({
      block,
      state: conflicts.has(block.id) ? ("conflict" as const) : block.state,
      layout: blockLayout(block),
    }));
  }, [blocks]);

  const rows = gridRowCount();
  const slots = gridSlotLabels();

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.dataset.gridBlock) return;
    const { key } = event;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
    event.preventDefault();

    const buttons = Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-grid-block]") ?? [],
    ).filter((button) => button !== target);
    if (buttons.length === 0) return;

    const current = { day: Number(target.dataset.day), start: Number(target.dataset.start) };
    let best: HTMLButtonElement | null = null;
    let bestDay = 0;
    let bestStart = 0;

    for (const button of buttons) {
      const day = Number(button.dataset.day);
      const start = Number(button.dataset.start);
      let candidate = false;

      if (key === "ArrowUp") {
        candidate = day === current.day && start < current.start;
      } else if (key === "ArrowDown") {
        candidate = day === current.day && start > current.start;
      } else if (key === "ArrowLeft") {
        candidate = day < current.day;
      } else {
        candidate = day > current.day;
      }
      if (!candidate) continue;

      if (!best) {
        best = button;
        bestDay = day;
        bestStart = start;
        continue;
      }

      const key2 = key === "ArrowUp" ? "max-start" : key === "ArrowDown" ? "min-start" : key === "ArrowLeft" ? "max-day" : "min-day";
      const better =
        key2 === "max-start"
          ? start > bestStart
          : key2 === "min-start"
            ? start < bestStart
            : key2 === "max-day"
              ? day > bestDay || (day === bestDay && start > bestStart)
              : day < bestDay || (day === bestDay && start < bestStart);

      if (better) {
        best = button;
        bestDay = day;
        bestStart = start;
      }
    }

    best?.focus();
  };

  const daysWithBlocks = GRID_DAYS.filter((day) => blocks.some((block) => block.day === day));

  return (
    <div>
      <div ref={containerRef} onKeyDown={handleKeyDown} className="hidden lg:block">
        <div className="border border-rule bg-surface">
          <div className="grid" style={{ gridTemplateColumns: "3.75rem repeat(5, minmax(0, 1fr))" }}>
            <div className="border-b border-ink" />
            {GRID_DAYS.map((day) => (
              <div key={day} className="border-b border-l border-ink px-2 py-1 text-label font-semibold">
                {dayName(day)}
              </div>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns: "3.75rem repeat(5, minmax(0, 1fr))" }}>
            <div>
              {slots.map((minute) => (
                <div
                  key={minute}
                  style={{ height: ROW_PX }}
                  className="pr-2 text-right text-micro text-ink-soft"
                >
                  {minute % 60 === 0 ? formatTime(minute) : ""}
                </div>
              ))}
            </div>
            {GRID_DAYS.map((day) => (
              <div
                key={day}
                className="relative border-l border-rule"
                style={{
                  height: rows * ROW_PX,
                  backgroundImage: `repeating-linear-gradient(to bottom, var(--color-rule) 0 1px, transparent 1px ${ROW_PX}px)`,
                }}
              >
                {resolved
                  .filter((entry) => entry.block.day === day)
                  .map(({ block, state, layout }) => (
                    <button
                      key={block.id}
                      type="button"
                      data-grid-block={block.id}
                      data-day={block.day}
                      data-start={block.startMin}
                      onClick={() => onSelect?.(block)}
                      aria-label={`${block.label}${block.sublabel ? `, ${block.sublabel}` : ""}, ${dayName(block.day)} ${formatRange(block.startMin, block.endMin)}`}
                      className={`absolute left-0.5 right-0.5 overflow-hidden px-1.5 py-1 text-left font-display text-micro font-semibold ${STATE_CLASSES[state]}`}
                      style={{
                        top: (layout.rowStart - 1) * ROW_PX + 2,
                        height: layout.rowSpan * ROW_PX - 4,
                      }}
                    >
                      <span className="block truncate">{block.label}</span>
                      {layout.rowSpan >= 2 && block.sublabel ? (
                        <span className="block truncate font-body font-normal opacity-80">
                          {block.sublabel}
                        </span>
                      ) : null}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="lg:hidden">
        {daysWithBlocks.length === 0 ? (
          <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">{emptyLabel}</p>
        ) : (
          daysWithBlocks.map((day) => (
            <section key={day} className="mt-4 first:mt-0">
              <h3 className="font-display text-label font-semibold">{dayName(day)}</h3>
              <ul className="mt-1 border border-rule bg-surface">
                {blocks
                  .filter((block) => block.day === day)
                  .sort((left, right) => left.startMin - right.startMin)
                  .map((block) => {
                    const state = resolved.find((entry) => entry.block.id === block.id)?.state ?? block.state;
                    return (
                      <li key={block.id} className="border-t border-rule first:border-t-0">
                        <button
                          type="button"
                          onClick={() => onSelect?.(block)}
                          className="w-full px-3 py-2 text-left"
                        >
                          <span className="figure text-micro text-ink-soft">
                            {formatRange(block.startMin, block.endMin)}
                          </span>
                          <span className="ml-2 font-display text-body font-semibold">{block.label}</span>
                          {block.sublabel ? (
                            <span className="ml-2 text-micro text-ink-soft">{block.sublabel}</span>
                          ) : null}
                          {state === "conflict" ? (
                            <span className="ml-2">
                              <StatusMark cue="stamp">Conflict</StatusMark>
                            </span>
                          ) : null}
                          {state === "waitlisted" ? (
                            <span className="ml-2">
                              <StatusMark cue="hatch">Waitlisted</StatusMark>
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
