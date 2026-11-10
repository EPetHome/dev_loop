#!/usr/bin/env node
import { hookMain } from "../src/hosts/hook.ts";
hookMain().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
