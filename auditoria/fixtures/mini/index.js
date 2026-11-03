import { used } from "./a.js";
import { priceA, priceB, logA, logB, twinA, twinB } from "./dup.js";
import { readCompound, keepFetch } from "./side-effects.js";

export function run(x) {
  return (
    used(x) +
    priceA([{ value: x, qty: 1 }]) +
    priceB([{ value: x, qty: 1 }]) +
    logA("a") +
    logB("a") +
    twinA(x) +
    twinB(x) +
    readCompound(0) +
    keepFetch()
  );
}
