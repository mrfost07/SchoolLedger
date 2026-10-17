"use client";

import { useSyncExternalStore } from "react";

type Listener = () => void;

let nowMs: number | null = null;
let timer: number | null = null;
const listeners = new Set<Listener>();

function ensureTimer() {
  if (timer !== null) return;
  nowMs = Date.now();
  timer = window.setInterval(() => {
    nowMs = Date.now();
    listeners.forEach((listener) => listener());
  }, 30_000);
}

function releaseTimer() {
  if (listeners.size === 0 && timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  ensureTimer();
  return () => {
    listeners.delete(listener);
    releaseTimer();
  };
}

function getSnapshot(): number | null {
  return nowMs;
}

function getServerSnapshot(): null {
  return null;
}

export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
