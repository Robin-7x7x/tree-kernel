# 树状展开执行内核 · tree-kernel

> 执行不是待办清单，而是一次从目的出发的分形展开。

一个「让 Agent 先理解目的、再分形展开」的最小可运行内核。零依赖、单文件、Node 18+。

**这是精简内核版**——只保留「树状展开」这一条主干，完整系统的接入层与性能层已省略。

## 原理

执行永远是从 A 到 B：**A** 是委托人的原话，**B** 是我理解的目的。要达成 B，就拆成几个更小的 B；每个小 B 再拆……直到「成败可判定」且「一口气能做完」——那就是叶子，直接做。

**达成是算出来的，不是标出来的**：叶子看自己；有子的节点要等子节点全达成，再由自己验收一次。所以手标父节点无效。

机制用三道门逼思考发生（只逼表态，不判对错）：**规划门**（光杆根不许动手）、**变数门**（连续失败 2 次先改计划）、**收尾门**（根收尾必须交复核结论）。

完整原理与实测记录见 [`树状展开执行内核.pdf`](./树状展开执行内核.pdf)（9 页）。

## 快速开始

无需安装任何依赖：

```bash
node tree-kernel.mjs demo                                  # 完整生命周期演示
node tree-kernel.mjs begin --b "要到达什么" --from "原话"   # 登记根节点
node tree-kernel.mjs begin --parent n1 --b "第一步"         # 拆一个切面
node tree-kernel.mjs guard                                 # 查当前是否被拦
node tree-kernel.mjs done  --node n2                       # 叶子完成
node tree-kernel.mjs done  --node n1 --review "复核结论"    # 根收尾（必须带结论）
node tree-kernel.mjs view                                  # 看全树
node tree-kernel.mjs reset                                 # 清树（自动存底）
```

状态默认存在 `./.tree-state.json`，可用 `--state <文件>` 指定；`reset` 前的旧树写入 `archive/`。

## 文件

| 文件 | 说明 |
|---|---|
| `tree-kernel.mjs` | 内核源码，410 行，零依赖 |
| `树状展开执行内核.pdf` | 完整报告：原理、实现与可复现实测 |