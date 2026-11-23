import cp from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

export const fixtureMarker = "dev-loop generated fixture";

// Darwin can spend seconds assessing each freshly checked-out executable, even a no-op.
// Treat marked test doubles as interpreter input. Keep real child processes, cwd, argv,
// stdio, process groups and exit codes. Unmarked scripts still exercise direct exec.
if (process.platform === "darwin") {
  // Projects can override TMPDIR for their scripts; keep the harness root fixed.
  const root = process.env.DEV_LOOP_FIXTURE_TMP || realpathSync(tmpdir()), spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    const interpreter = Array.isArray(args) && !options?.shell && interpreterFor(command);
    return interpreter ? spawn(interpreter, [command, ...args], options) : spawn.apply(this, arguments);
  };
  syncBuiltinESMExports();

  function interpreterFor(command) {
    if (typeof command !== "string" || !isAbsolute(command)) return;
    try {
      if (!lstatSync(command).isFile()) return;
      const folder = relative(root, realpathSync(command)).split(sep)[0];
      if (!/^(?:dev-loop-test-|dev-loop-check-|\.loop-snapshot-)/.test(folder)) return;
      accessSync(command, constants.X_OK);
      const source = readFileSync(command, "utf8");
      if (source.startsWith(`#!/bin/sh\n# ${fixtureMarker}\n`)) return "/bin/sh";
      if (source.startsWith(`#!${process.execPath}\n// ${fixtureMarker}\n`)) return process.execPath;
    } catch { return undefined; } // The ordinary spawn reports missing/denied files.
  }
}
