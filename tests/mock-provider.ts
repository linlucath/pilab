// Local-only browser QA fixture; never used by the application in production.
import { createServer } from "node:http";
const output =
  "这是本地联调接口的测试回答。\n\n上下文就像一张工作便签：模型会参考你放进去的指令、问题和历史回答。修改任意一条便签，再次运行，就能对比结果。\n\n此内容仅用于验证流式输出，不是真实模型生成。";
createServer(async (req, res) => {
  for await (const _ of req) {
    /* consume */
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const text of output.match(/.{1,8}|\n/g) || []) {
    if (res.destroyed) return;
    res.write(
      `data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", model: "local-test", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  res.write(
    `data: ${JSON.stringify({ id: "qa", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 91, completion_tokens: 76, total_tokens: 167 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}).listen(3001, "127.0.0.1", () =>
  console.log("QA mock listening on 127.0.0.1:3001"),
);
