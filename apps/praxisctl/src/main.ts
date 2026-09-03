#!/usr/bin/env -S node --experimental-strip-types
// Node's runtime type stripper requires the explicit extension.
// @ts-expect-error -- the workspace compiler intentionally leaves TS source un-emitted.
import { runPraxisCli } from "./cli.ts";

void runPraxisCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
