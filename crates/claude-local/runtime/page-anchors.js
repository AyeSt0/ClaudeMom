// Claude 页面的锚点表：每个挂载点在 Claude 的 DOM 里挂在哪。
//
// 单独放一个文件，是因为这部分跟着 Claude 的前端改版走，和运行时本身的逻辑分开改、分开测
// （样本在 fixtures/dom/，测试见 page-anchors.test.mjs）。每个挂载点给多个候选，按顺序试，
// 第一个找得到且可见的生效；全都找不到时那个挂载点不出现，拓展的其余部分照常工作。
//
// 选择器优先用 data-testid：它们是 Claude 前端自己的测试标识，比类名稳定。
window.__codexPlusClaudeAnchors = {
  version: 1,
  /** 当前是哪个页签：按顺序试，第一个命中的算数。 */
  surfaces: [
    { name: "code", test: '[data-testid="code-prompt-input"]' },
    { name: "chat", test: '[data-testid="chat-input"]' },
  ],
  mounts: {},
};
