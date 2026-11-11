import { join } from "node:path";
import { digest } from "./files.ts";
export const projectFile = (root: string, repo: string, kind: string) => join(root,"."+kind+"-"+digest(repo).slice(0,20)+(kind==="queue"?".lock":".json"));
