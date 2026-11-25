// 只供自检的顺序准备/检查：用原 CLI 分派，省去这些步骤之间的 Node 启动。
import { main } from "../src/cli/main.ts";

const [mode, target] = process.argv.slice(2);
if (mode === "prepare") {
  const opened = await main(["启动", target]) as {executionId:string;taskDir:string};
  await main(["准备", opened.executionId]);
  console.log(JSON.stringify(opened));
} else if (mode === "settle" || mode === "deliver-and-settle") {
  const delivery = mode === "deliver-and-settle" ? await main(["交付"]) : undefined;
  await main(["复测", target]);
  await main(["评审", target]);
  if (delivery) console.log(JSON.stringify(delivery));
} else {
  throw new Error("未知自检入口：" + mode);
}
